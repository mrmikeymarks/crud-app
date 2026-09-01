import { crudRouter } from "../../lib/crud.js";
import items from "./config.js";

// GET/POST /items, GET/PUT/DELETE /items/:id, GET /items?task_id=N
export default crudRouter(items);
