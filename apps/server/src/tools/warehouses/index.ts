import { bulkInitializeStockTool } from "./bulk.js";
import {
  getWarehouseSaturationTool,
  getWarehouseTool,
  listWarehousesTool,
  resolveWarehouseTool,
} from "./list.js";
import { setReorderPointTool } from "./reorder.js";
import { transferStockTool } from "./transfer.js";
import {
  createWarehouseTool,
  deactivateWarehouseTool,
  updateWarehouseTool,
} from "./write.js";

export const warehousesTools = [
  listWarehousesTool,
  getWarehouseTool,
  resolveWarehouseTool,
  getWarehouseSaturationTool,
  createWarehouseTool,
  updateWarehouseTool,
  deactivateWarehouseTool,
  transferStockTool,
  setReorderPointTool,
  bulkInitializeStockTool,
];
