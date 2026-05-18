import { recordStockMovement } from "./record.js";
import { reverseStockMovement } from "./reverse.js";
import { getStockHistory, listStockMovements } from "./list.js";

export const movementsTools = [
  recordStockMovement,
  reverseStockMovement,
  listStockMovements,
  getStockHistory,
];
