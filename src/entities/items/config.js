// An item belongs to a task (optional: task_id may be null for loose items).
export default {
  table: "items",
  columns: ["name", "description"],
  required: ["name"],
  parent: { table: "tasks", key: "task_id" },
};
