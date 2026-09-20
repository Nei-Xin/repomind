import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Database } from "../src/storage/database.js";

describe("database transaction recovery", () => {
  let database: Database;

  beforeEach(() => {
    database = new Database(":memory:");
    database.raw.exec("CREATE TABLE transaction_items (id INTEGER PRIMARY KEY)");
  });

  afterEach(() => database.close());

  function insert(id: number): void {
    database.raw.prepare("INSERT INTO transaction_items VALUES (?)").run(id);
  }

  function ids(): number[] {
    return (database.raw.prepare("SELECT id FROM transaction_items ORDER BY id").all() as Array<{ id: number }>)
      .map((row) => row.id);
  }

  // A subsequent transaction must really commit, not merely release a savepoint
  // inside a leaked outer transaction.
  function expectReusableConnection(): void {
    expect(database.transaction(() => { insert(99); return "committed"; })).toBe("committed");
    database.raw.exec("BEGIN IMMEDIATE; ROLLBACK;");
    expect(ids()).toContain(99);
  }

  it("rolls back callback failures and preserves the original error", () => {
    const failure = new Error("work failed");
    expect(() => database.transaction(() => {
      insert(1);
      throw failure;
    })).toThrow(failure);
    expect(ids()).toEqual([]);
    expectReusableConnection();
  });

  it("recovers when a deferred foreign key fails at COMMIT", () => {
    database.raw.exec(`
      CREATE TABLE transaction_children (
        parent_id INTEGER REFERENCES transaction_items(id) DEFERRABLE INITIALLY DEFERRED
      );
    `);
    expect(() => database.transaction(() => {
      insert(1);
      database.raw.exec("INSERT INTO transaction_children VALUES (42)");
    })).toThrow(/FOREIGN KEY constraint failed/);
    expect(ids()).toEqual([]);
    expect(database.raw.prepare("SELECT * FROM transaction_children").all()).toEqual([]);
    expectReusableConnection();
  });

  it("lets the outer transaction continue after a nested rollback", () => {
    database.transaction(() => {
      insert(1);
      expect(() => database.transaction(() => {
        insert(2);
        throw new Error("nested work failed");
      })).toThrow("nested work failed");
      database.transaction(() => insert(3));
      insert(4);
    });
    expect(ids()).toEqual([1, 3, 4]);
    expectReusableConnection();
  });

  it("rolls back successful nested work when the outer transaction fails", () => {
    expect(() => database.transaction(() => {
      insert(1);
      database.transaction(() => insert(2));
      throw new Error("outer work failed");
    })).toThrow("outer work failed");
    expect(ids()).toEqual([]);
    expectReusableConnection();
  });

  it("retains the original cause when SQLite has already rolled back", () => {
    let originalError: unknown;
    let caught: unknown;
    try {
      database.transaction(() => {
        insert(1);
        try {
          database.raw.exec("INSERT OR ROLLBACK INTO transaction_items VALUES (1)");
        } catch (error) {
          originalError = error;
          throw error;
        }
      });
    } catch (error) {
      caught = error;
    }
    expect(originalError).toBeInstanceOf(Error);
    expect(caught).toBeInstanceOf(AggregateError);
    const failure = caught as AggregateError;
    expect(failure.cause).toBe(originalError);
    expect(failure.errors[0]).toBe(originalError);
    expect(failure.errors[1].message).toMatch(/no transaction is active/);
    expect(ids()).toEqual([]);
    expectReusableConnection();
  });
});
