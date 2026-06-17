const saveOrder = require('./saveOrder');

const orderNumber = saveOrder({
  squareOrderId: 'TEST123',
  customerName: 'Skye Walker',
  phone: '8162077623',
  email: 'info@thefamilypantry.org',
  address: '203 Patricia Street, Plattsburg, MO 64477',
  deliveryTime: '2026-07-10 13:20',
  paymentMethod: 'Cash',
  status: 'Received',
  subtotal: 13.90,
  deliveryFee: 3.00,
  salesTax: 1.14,
  tip: 0,
  total: 18.04,
});

console.log('Created:', orderNumber);