require("dotenv").config({ override: true });
const mysql = require("mysql2/promise");
const { Stripe } = require("stripe");
const fs = require("fs");
const csv = require("fast-csv");

const requiredEnvVars = [
  "STRIPE_SECRET_KEY",
  "SSH_HOST",
  "SSH_USER",
  "SSH_PRIVATE_KEY_PATH",
  "MYSQL_HOST",
  "MYSQL_USER",
  "MYSQL_PASSWORD",
  "MYSQL_DATABASE",
  "DRY_RUN",
  "CREATE_CUSTOMER",
  "REMOVE_AND_REDO_SUBSCRIPTIONS",
  "CREATE_COUPONS",
];

let couponsCache = [];

const getDateTimeString = () => {
  const now = new Date();
  const YYYY = now.getFullYear();
  const MM = String(now.getMonth() + 1).padStart(2, "0");
  const DD = String(now.getDate()).padStart(2, "0");
  const HH = String(now.getHours()).padStart(2, "0");
  const MI = String(now.getMinutes()).padStart(2, "0");
  const SS = String(now.getSeconds()).padStart(2, "0");

  return `${YYYY}${MM}${DD}-${HH}${MI}${SS}`;
};

const filename = `./migrations/${getDateTimeString()}-customer-migrations.csv`;

function validateEnvironmentVariables() {
  const missingVars = requiredEnvVars.filter(
    (envVar) => !process.env[envVar] || process.env[envVar] === ""
  );

  if (missingVars.length) {
    throw new Error(
      `Missing required environment variables: ${missingVars.join(", ")}`
    );
  }
}

async function getValidPaymentMethods(customerId) {
  try {
    const paymentMethods = await stripe.paymentMethods.list({
      customer: customerId,
      type: "card",
    });

    const currentYear = new Date().getFullYear();
    const currentMonth = new Date().getMonth() + 1; // JavaScript months are 0-indexed

    const validMethods = paymentMethods.data.filter((method) => {
      // Check if the card's expiration year is in the future OR
      // if it's the current year but the expiration month hasn't passed yet
      return (
        method.card.exp_year > currentYear ||
        (method.card.exp_year === currentYear &&
          method.card.exp_month >= currentMonth)
      );
    });

    if (validMethods.length === 0) {
      console.warn(
        `No valid payment methods found for customer ${customerId}.`
      );
      return null;
    }

    return validMethods[0].id;
  } catch (error) {
    console.error("Error retrieving payment methods:", error);
    return null;
  }
}

let migratedCount = 0;
let failedCount = 0;
let stripe = null;

async function main() {
  try {
    validateEnvironmentVariables();
  } catch (err) {
    console.error(err.message);
    process.exit(1);
  }

  const writeStream = await fs.createWriteStream(filename);
  const csvStream = csv.format({ headers: true });

  csvStream.pipe(writeStream);

  stripe = new Stripe(process.env.STRIPE_SECRET_KEY);

  let connection = null;

  const dbConfig = {
    host: "127.0.0.1",
    port: 3306,
    user: process.env.MYSQL_USER,
    password: process.env.MYSQL_PASSWORD,
    database: process.env.MYSQL_DATABASE,
  };

  console.log("Connecting to MySQL over SSH tunnel...");
  console.log(dbConfig);

  try {
    connection = await mysql.createConnection(dbConfig);
    console.log("Connected to MySQL over SSH tunnel!");

    const [subscriptions] = await connection.execute(`
              SELECT
                  p.*,
                  m1.meta_value AS next_payment_date,
                  m2.meta_value AS user_id
              FROM wp_posts p
              JOIN wp_postmeta m1 ON p.ID = m1.post_id AND m1.meta_key = '_schedule_next_payment'
              JOIN wp_postmeta m2 ON p.ID = m2.post_id AND m2.meta_key = '_customer_user'
              WHERE p.post_type = 'shop_subscription'
              AND p.post_status = 'wc-active'
              AND m1.meta_value < DATE_ADD(CURDATE(), INTERVAL 1 YEAR);
          `);

    const csvRows = [];

    for (const subscription of subscriptions) {
      try {
        const userEmail = await getUserEmail(connection, subscription.user_id);
        let stripeCustomer = await findStripeCustomerByUserId(
          subscription.user_id
        );

        if (process.env.CREATE_CUSTOMER === "true") {
          if (!stripeCustomer) {
            stripeCustomer = await createStripeCustomerFromWooCommerce(
              subscription.user_id,
              connection
            );
            if (!stripeCustomer) {
              console.log(
                `Failed to create Stripe customer for WooCommerce user_id ${subscription.user_id}.`
              );
              continue;
            }
          }
        } else {
          if (!stripeCustomer) {
            console.log(
              `No Stripe customer found for WooCommerce user_id ${subscription.user_id}.`
            );
            csvRows.push({
              customer_email: userEmail,
              stripe_customer_id: null,
              status: "failed",
              comment: "No Stripe customer found for WooCommerce user_id",
            });
            csvRows.forEach((row) => csvStream.write(row));
            continue;
          }
        }

        const alreadyHasSubscription = await hasActiveStripeSubscription(
          stripeCustomer.id
        );
        if (alreadyHasSubscription) {
          console.log(
            `Stripe customer ${stripeCustomer.id} already has an active subscription.`
          );

          if (
            process.env.REMOVE_AND_REDO_SUBSCRIPTIONS === "true" &&
            process.env.DRY_RUN !== "true"
          ) {
            await checkAndRemoveSubscription(stripeCustomer.id);
          } else {
            console.log(`DRY RUN: Would have deleted the users subscription.`);
          }
        }

        const priceIds = await getPriceIdsForSubscription(
          subscription.ID,
          connection
        );

        const stripePriceInfo = priceIds.map((priceId) => {
          return {
            price: priceId,
          };
        });

        const today = new Date();
        today.setHours(0, 0, 0, 0);
        const next_payment_date = new Date(subscription.next_payment_date);
        if (process.env.DEBUG === "true")
          console.log(`Next Billing Date: ${subscription.next_payment_date}`);
        next_payment_date.setHours(0, 0, 0, 0);
        if (next_payment_date.getTime() === today.getTime()) {
          console.warn(
            `Subscription ${subscription.ID} renews today! The user may be charged twice.`
          );
        }

        const wooCommerceCoupons = await getCouponsForSubscription(
          connection,
          subscription.ID
        );
        if (process.env.DEBUG === "true")
          console.log(
            `DEBUG: Coupons for subscription ${
              subscription.ID
            }: ${JSON.stringify(wooCommerceCoupons)}`
          );
        let stripeCouponIds = [];
        if (
          process.env.DRY_RUN !== "true" &&
          process.env.CREATE_COUPONS === "true"
        ) {
          stripeCouponIds = await createStripeCoupons(
            wooCommerceCoupons,
            subscription.ID
          );
        } else {
          console.log(
            `DRY_RUN: Would create ${wooCommerceCoupons.length} coupons for ${subscription.ID}.`
          );
        }

        if (
          process.env.DRY_RUN !== "true" &&
          process.env.CREATE_SUBSCRIPTIONS === "true"
        ) {
          const paymentMethod = await getValidPaymentMethods(stripeCustomer.id);

          if (!paymentMethod) {
            csvRows.push({
              customer_email: userEmail,
              stripe_customer_id: stripeCustomer.id,
              status: "failed",
              comment: "No payment method found for customer",
            });
            csvRows.forEach((row) => csvStream.write(row));
            failedCount++;
            continue;
          }

          const subscriptionData = {
            customer: stripeCustomer.id,
            items: stripePriceInfo,
            // Convert the next payment date to a Unix timestamp
            billing_cycle_anchor:
              new Date(subscription.next_payment_date).getTime() / 1000,
            default_payment_method: paymentMethod,
          };

          if (stripeCouponIds.length > 0) {
            subscriptionData.coupon = stripeCouponIds[0];
          }

          const stripeSubscription = await stripe.subscriptions.create(
            subscriptionData
          );

          console.log(
            `Created Stripe subscription ${stripeSubscription.id} for WooCommerce subscription ${subscription.ID}.`
          );
        } else {
          console.log(
            `DRY_RUN: Would create a Stripe subscription for WooCommerce subscription ${
              subscription.ID
            }. Details:
            Customer ID: ${stripeCustomer.id},
            Items: ${JSON.stringify(stripePriceInfo)},
            Billing cycle anchor: ${new Date(subscription.next_payment_date)}
            Coupon: ${stripeCouponIds[0]}
            `
          );
        }

        migratedCount++;
        console.log(`Migrated ${userEmail}`);
        console.log(`Migrated ${migratedCount} customers successfully.`);
        console.log(`Failed to migrate ${failedCount} customers.`);
        console.log(
          `Completed: ${migratedCount + failedCount}/${
            subscriptions.length
          } customers.`
        );
        csvRows.push({
          customer_email: userEmail,
          stripe_customer_id: stripeCustomer.id,
          status: "success",
        });
        csvRows.forEach((row) => csvStream.write(row));
      } catch (dbError) {
        console.error("MySQL connection error:", dbError);
      }
    }

    // Write the CSV file
    csvStream.end();
    console.log(`File ${filename} has been created.`);
    console.log(`Migrated ${migratedCount} customers.`);
  } catch (dbError) {
    console.error("MySQL connection error:", dbError);
  }
}

async function findStripeCustomerByUserId(userId) {
  const customers = await stripe.customers.search({
    limit: 1,
    query: `metadata['user_id']:'${userId}'`,
  });

  return customers.data[0] || null;
}

async function getPriceByProductName(productName) {
  try {
    // 1. Fetch products by name
    const products = await stripe.products.list({
      limit: 10, // You can adjust the limit as needed
      active: true,
    });

    // Find product with the given name
    const product = products.data.find((p) => p.name === productName);

    if (!product) {
      if (process.env.DEBUG === "true")
        console.log(`Product with name ${productName} not found.`);
      return;
    }

    // 2. Fetch prices for the found product
    const prices = await stripe.prices.list({
      product: product.id,
      active: true,
    });

    // Print all the active prices for the product
    if (process.env.DEBUG === "true") {
      prices.data.forEach((price) => {
        console.log(
          `Price ID: ${price.id}, Amount: ${price.unit_amount}, Currency: ${price.currency}`
        );
      });
    }

    // Return the list of prices (you can adjust as needed)
    return prices.data;
  } catch (error) {
    console.error("An error occurred:", error);
  }
}

async function getCouponsForSubscription(connection, subscriptionId) {
  const query = `
        SELECT
    order_items.order_item_name AS coupon_code,
    discount_meta.meta_value AS coupon_amount,
    currency_meta.meta_value AS currency
FROM
    wp_woocommerce_order_items AS order_items
-- Join with itemmeta to get coupon amount
JOIN
    wp_woocommerce_order_itemmeta AS discount_meta ON order_items.order_item_id = discount_meta.order_item_id AND discount_meta.meta_key = 'discount_amount'
-- Get the currency of the order
JOIN
    wp_postmeta AS currency_meta ON order_items.order_id = currency_meta.post_id AND currency_meta.meta_key = '_order_currency'
WHERE
    order_items.order_id = ? AND order_items.order_item_type = 'coupon';

    `;

  const [rows] = await connection.execute(query, [subscriptionId]);

  return rows.map((row) => {
    return {
      code: row.coupon_code,
      amount: row.coupon_amount,
      currency: row.currency,
    };
  });
}

async function findStripeCouponByCode(code) {
  if (couponsCache.length === 0) {
    couponsCache = await stripe.coupons.list();
  }
  const coupon = couponsCache.data.find((c) => c.name === code);

  return coupon || null;
}

async function createStripeCoupons(wooCommerceCoupons, subscriptionID) {
  // You'll need to provide more details about how to map WooCommerce coupon stats to Stripe's
  // Assuming a basic coupon for a fixed amount:

  const stripeCoupons = [];

  couponsCache = await stripe.coupons.list();

  for (const wooCoupon of wooCommerceCoupons) {
    const existingCoupon = await findStripeCouponByCode(
      wooCoupon.name || wooCoupon.code
    );

    if (existingCoupon) {
      console.log(
        `Coupon '${
          wooCoupon.name || wooCoupon.code
        }-${subscriptionID}' already exists in Stripe.`
      );
      stripeCoupons.push(existingCoupon.id);
      continue;
    }

    const coupon = await stripe.coupons.create({
      amount_off: Math.round(wooCoupon.amount * 100), // Convert to cents for Stripe
      currency: wooCoupon.currency,
      duration: "forever", // This might be different based on your use case
      id: `${wooCoupon.code}-${subscriptionID}`,
      name: `${wooCoupon.name || wooCoupon.code}-${subscriptionID}`,
      // ... add other parameters as required
    });

    stripeCoupons.push(coupon.id);
  }

  return stripeCoupons;
}

async function getPriceIdsForSubscription(subscriptionId, connection) {
  const products = await getWooCommerceSubscriptionDetails(
    subscriptionId,
    connection
  );

  if (!products || products.length === 0) {
    throw new Error(
      `No price found for WooCommerce subscription: ${subscriptionId}`
    );
  }

  const priceIds = [];

  let shippingCreated = false;

  for (const product of products) {
    const { priceAmount, currency, productName, shipping } = product;
    // Look for a matching price in Stripe using the product name
    const price = await getPriceByProductName(productName);

    if (
      price &&
      price.length > 0 &&
      price[0].currenty === currency &&
      price[0].unit_amount === priceAmount
    ) {
      // If a price exists, use the first one.
      priceIds.push(price[0].id);
      continue;
    }

    if (
      process.env.DRY_RUN !== "true" &&
      process.env.CREATE_PRODUCTS === "true"
    ) {
      // If the price doesn't exist in Stripe, create one using the product name.
      const newPrice = await stripe.prices.create({
        unit_amount: Math.round(priceAmount * 100), // amount in cents
        currency: currency,
        recurring: { interval: "year" }, // Subscriptions are always yearly
        product_data: {
          name: productName,
          metadata: {
            woocommerce_price: Math.round(priceAmount * 100),
            woocommerce_currency: currency,
          },
        },
      });
      priceIds.push(newPrice.id);

      // If the product has a shipping rate, create a new price for it.
      // But only create it once for each subscription
      if (shipping && shippingCreated === false) {
        const shippingPrice = await stripe.prices.create({
          unit_amount: Math.round(shipping * 100), // amount in cents
          currency: currency,
          recurring: { interval: "year" }, // Subscriptions are always yearly
          product_data: {
            name: `${productName} shipping`,
            metadata: {
              woocommerce_price: Math.round(shipping * 100),
              woocommerce_currency: currency,
              type: "shipping",
            },
          },
        });
        priceIds.push(shippingPrice.id);
        shippingCreated = true;
      }
    } else {
      console.log(
        `DRY_RUN: Would create a new price for product ${productName}.`
      );
    }
  }

  if (process.env.DEBUG === "true") console.log(priceIds);
  return priceIds;
}

async function getWooCommerceSubscriptionDetails(subscriptionId, connection) {
  // Fetching the price, the currency, and the associated product name for the WooCommerce subscription.
  const [results] = await connection.execute(
    `
    SELECT
    main.ID AS subscriptionId,
    main_total.meta_value AS subscriptionTotal,
    product.post_title AS productName,
    item_meta_price.meta_value AS productPrice,
    currency_meta.meta_value AS currency,
    customer_user.meta_value AS userID,
    stripe_user.meta_value AS stripeUser,
    shipping_meta_total.meta_value AS shippingRate,
    item_meta_product.meta_value AS productID,
    item_meta_variation.meta_value AS productVariationID
FROM
    wp_posts AS main
-- Get the overall subscription total
JOIN
    wp_postmeta AS main_total ON main.ID = main_total.post_id AND main_total.meta_key = '_order_total'
-- Get the order currency
JOIN
    wp_postmeta AS currency_meta ON main.ID = currency_meta.post_id AND currency_meta.meta_key = '_order_currency'
-- Get the customer user ID
JOIN
    wp_postmeta AS customer_user ON main.ID = customer_user.post_id AND customer_user.meta_key = '_customer_user'
-- Get the Stripe user ID
JOIN
    wp_postmeta AS stripe_user ON main.ID = stripe_user.post_id AND stripe_user.meta_key = '_wc_stripe_customer'
-- Join with the order items table to get each product
JOIN
    wp_woocommerce_order_items AS order_items ON main.ID = order_items.order_id AND order_items.order_item_type = 'line_item'
-- Get the product ID for each order item
JOIN
    wp_woocommerce_order_itemmeta AS item_meta_product ON order_items.order_item_id = item_meta_product.order_item_id AND item_meta_product.meta_key = '_product_id'
-- Get the product price for each order item
JOIN
    wp_woocommerce_order_itemmeta AS item_meta_price ON order_items.order_item_id = item_meta_price.order_item_id AND item_meta_price.meta_key = '_line_total'
-- Get the product name
JOIN
    wp_posts AS product ON item_meta_product.meta_value = product.ID
-- Get the shipping rate for the subscription order
LEFT JOIN
    wp_woocommerce_order_items AS shipping_items ON main.ID = shipping_items.order_id AND shipping_items.order_item_type = 'shipping'
LEFT JOIN
    wp_woocommerce_order_itemmeta AS shipping_meta_total ON shipping_items.order_item_id = shipping_meta_total.order_item_id AND shipping_meta_total.meta_key = 'cost'
LEFT JOIN
    wp_woocommerce_order_itemmeta AS item_meta_variation ON order_items.order_item_id = item_meta_variation.order_item_id AND item_meta_variation.meta_key = '_variation_id'
WHERE
    main.ID = ? AND main.post_type = 'shop_subscription';
    `,
    [subscriptionId]
  );

  if (process.env.DEBUG === "true") console.log(results);

  const products = [];

  if (results && results.length > 0) {
    for (const product of results) {
      const productActualPrice = await fetchProductPriceForCurrency(
        connection,
        Number(product.productVariationID) <= 0
          ? product.productID
          : product.productVariationID,
        product.currency
      );

      if (process.env.DEBUG === "true" && !productActualPrice)
        console.warn(
          `No price found for product ${product.productName} with currency ${product.currency}. Variation: ${product.productVariationID} Using ${product.productPrice} instead.`
        );
      products.push({
        pricePaidByCustomer: product.productPrice,
        priceAmount: productActualPrice || product.productPrice,
        currency: product.currency,
        productName: product.productName,
        shipping: product.shippingRate,
      });
    }
  }
  if (process.env.DEBUG === "true") console.log(products);
  return products;
}

const fetchProductPriceForCurrency = async (
  connection,
  productVariationID,
  currencyCode
) => {
  let query = `
        SELECT
            meta_value AS productPrices
        FROM
            wp_postmeta
        WHERE
            post_id = ?
        AND
            (meta_key = 'variable_regular_currency_prices' OR meta_key = '_regular_currency_prices')
    `;

  if (currencyCode === "USD") {
    query = `SELECT
            meta_value AS productPrices
        FROM
            wp_postmeta
        WHERE
            post_id = ?
        AND
            meta_key = '_subscription_price'`;
  }

  const [rows] = await connection.execute(query, [productVariationID]);

  if (process.env.DEBUG === "true") console.log(rows);

  // If no price is found for the given currency, return null
  if (rows.length === 0) {
    return null;
  }

  if (currencyCode === "USD") return rows[0].productPrices;

  // Otherwise, parse the price from the JSON string
  const productPrices = JSON.parse(rows[0].productPrices);

  // Return the price for the given currency
  return productPrices[currencyCode];
};

async function hasActiveStripeSubscription(customerId) {
  const subscriptions = await stripe.subscriptions.list({
    customer: customerId,
    status: "active",
    limit: 1,
  });

  return subscriptions.data.length > 0;
}

async function getUserEmail(connection, user_id) {
  const query = `
        SELECT user_email
        FROM wp_users
        WHERE ID = ?
    `;

  try {
    const [rows] = await connection.execute(query, [user_id]);

    if (rows.length > 0) {
      return rows[0].user_email;
    } else {
      throw new Error(`No user found for ID ${user_id}`);
    }
  } catch (err) {
    console.error("Error fetching user email:", err);
    throw err;
  }
}

async function createStripeCustomerFromWooCommerce(userId, connection) {
  // First, retrieve the email associated with the WordPress user ID.
  const userEmail = await getUserEmail(connection, userId);

  if (!userEmail) {
    console.error(`No email found for user ID ${userId}`);
    return null;
  }

  // Create a new Stripe customer.
  const newCustomer = await stripe.customers.create({
    email: userEmail,
    metadata: { user_id: userId.toString() },
  });

  console.log(
    `Created new Stripe customer with ID ${newCustomer.id} for WooCommerce user ${userId}`
  );
  return newCustomer;
}

async function checkAndRemoveSubscription(stripeCustomerId) {
  try {
    // List all subscriptions for the given customer ID
    const subscriptions = await stripe.subscriptions.list({
      customer: stripeCustomerId,
      status: "active",
    });

    console.log(
      `Found ${subscriptions.data.length} subscriptions for customer ${stripeCustomerId}`
    );

    if (process.env.REMOVE_AND_REDO_SUBSCRIPTIONS === "true") {
      // If customer has one or more active subscriptions, delete them
      for (const subscription of subscriptions.data) {
        await stripe.subscriptions.del(subscription.id);
        console.log(
          `Subscription ${subscription.id} deleted for customer ${stripeCustomerId}`
        );
      }
    }
  } catch (error) {
    console.error("An error occurred:", error);
  }
}

main().catch((error) => {
  console.error("An error occurred:", error.message);
});
