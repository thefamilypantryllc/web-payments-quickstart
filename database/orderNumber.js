function generateOrderNumber(id) {
  const year = new Date().getFullYear();

  return `TFP-${year}-${String(id).padStart(4, '0')}`;
}

module.exports = generateOrderNumber;
