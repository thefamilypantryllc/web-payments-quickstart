const db = require('./db');
const generateOrderNumber = require('./orderNumber');

function saveOrder(orderData) {
  const insert = db.prepare(`
    INSERT INTO orders (
      square_order_id,
      customer_name,
      phone,
      email,
      address,
      delivery_time,
      payment_method,
      status,
      subtotal,
      delivery_fee,
      sales_tax,
      tip,
      total
    )
    VALUES (
      ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?
    )
  `);

  const result = insert.run(
    orderData.squareOrderId,
    orderData.customerName,
    orderData.phone,
    orderData.email,
    orderData.address,
    orderData.deliveryTime,
    orderData.paymentMethod,
    orderData.status,
    orderData.subtotal,
    orderData.deliveryFee,
    orderData.salesTax,
    orderData.tip,
    orderData.total,
  );

  const orderNumber = generateOrderNumber(result.lastInsertRowid);

  db.prepare(`
    UPDATE orders
    SET order_number = ?
    WHERE id = ?
  `).run(orderNumber, result.lastInsertRowid);

  return orderNumber;
}

module.exports = saveOrder;