// A task (or reminder) is a parent; its items are listed under /tasks/:id/items.
export default {
  table: "tasks",
  columns: ["title", "due_at", "done"],
  required: ["title"],
};
