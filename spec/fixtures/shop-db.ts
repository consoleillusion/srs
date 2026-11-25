import { Database } from 'bun:sqlite'

/**
 * Write a small shop database the way another program might have made it:
 * mixed-case names, integer and text keys, a composite key, foreign keys,
 * dates as text, and names that clash with SRS's own.
 *
 * @param file - Where to write it.
 */
export const writeShopDatabase =
  (file: string) => {
    const db = new Database(file, { create: true })
    db.exec(`
      PRAGMA foreign_keys = ON;
      CREATE TABLE Customers (CustomerNo INTEGER PRIMARY KEY, Name VARCHAR(80) NOT NULL, Email TEXT UNIQUE, Active BOOLEAN DEFAULT 1, CreatedAt DATETIME DEFAULT CURRENT_TIMESTAMP);
      CREATE TABLE products (sku TEXT PRIMARY KEY, title TEXT NOT NULL, price NUMERIC(10,2), CHECK (price >= 0));
      CREATE TABLE orders (id INTEGER PRIMARY KEY, customer INTEGER NOT NULL REFERENCES Customers(CustomerNo) ON DELETE CASCADE, placed_at TEXT, note TEXT, owner TEXT);
      CREATE TABLE order_items (order_id INTEGER REFERENCES orders(id), sku TEXT REFERENCES products, qty INTEGER NOT NULL DEFAULT 1, PRIMARY KEY (order_id, sku));
      CREATE TABLE user (login TEXT PRIMARY KEY, full_name TEXT);
      CREATE INDEX orders_placed ON orders(placed_at);
      CREATE VIEW big_orders AS SELECT * FROM orders;
      INSERT INTO Customers VALUES (7, 'Ada', 'ada@example.com', 1, '2024-05-01 10:00:00'), (9, 'Bo', NULL, 0, '2024-06-02 11:30:00');
      INSERT INTO products VALUES ('LAMP-1', 'Lamp', 19.5), ('DESK-2', 'Desk', 120);
      INSERT INTO orders VALUES (100, 7, '2024-07-01T09:00:00Z', 'first', 'legacy'), (101, 9, NULL, NULL, NULL);
      INSERT INTO order_items VALUES (100, 'LAMP-1', 2), (100, 'DESK-2', 1), (101, 'LAMP-1', 5);
      INSERT INTO user VALUES ('paul', 'Paul');
    `)
    db.close()
  }
