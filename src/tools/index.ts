import { movementsTools } from "./movements/index.js";
import { productsTools } from "./products/index.js";
import { suppliersTools } from "./suppliers/index.js";
import { warehousesTools } from "./warehouses/index.js";

export const tools = [
  ...productsTools,
  ...suppliersTools,
  ...warehousesTools,
  ...movementsTools,
];
