# Woocommerce Subscriptions to Stripe

## What this does

- Grabs all active woocommerce subscriptions renewing in the next year
- Grabs all the coupons and products associated with the order
- Checks if Stripe already has a subscription with the same products for that stripe customer.
- Creates the coupons in stripe suffixed with the subscriptionID (from Woo)
- Creates the products in stripe
- Creates the subscription in stripe (with the coupon applied)
- Creates a product for the shipping (even if the shipping is free) - as shipping is usually only applied using a stripe checkout method

Most actions of creating the products, coupons and subscriptions can be toggled on and off using the config file. The keys are self explanatory.

The `DRY_RUN` mode is an exception, which if true, will not create anything and give you a log of what it would have done.

## How to run

In one terminal window create a tunnel to the remote database.
In another, run node index.js in this folder.
