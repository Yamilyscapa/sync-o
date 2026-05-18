import { recordStockMovement } from "./record.js";
import { getStockHistory, listStockMovements } from "./list.js";

export const movementsTools = [
  recordStockMovement,
  listStockMovements,
  getStockHistory,
];
