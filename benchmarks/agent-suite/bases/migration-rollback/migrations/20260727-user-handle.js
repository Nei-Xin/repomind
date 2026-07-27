export async function up(db) {
  await db.exec("ALTER TABLE users ADD COLUMN handle TEXT");
  await db.exec("CREATE UNIQUE INDEX users_handle_uq ON users(handle)");
}

export async function down(db) {
  throw new Error("rollback not implemented");
}
