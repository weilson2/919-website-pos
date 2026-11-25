LIST_PRICE = 12.0


def ensure_list_price_columns(connection):
    for table, column, definition in (
        ("product_categories", "show_list_price", "INTEGER NOT NULL DEFAULT 0"),
        ("sales", "category_list_prices", "TEXT NOT NULL DEFAULT '{}'"),
    ):
        columns = {row[1] for row in connection.execute(f"PRAGMA table_info({table})")}
        if column not in columns:
            connection.execute(f"ALTER TABLE {table} ADD COLUMN {column} {definition}")


def category_list_prices(connection):
    return {
        name: LIST_PRICE
        for (name,) in connection.execute(
            "SELECT name FROM product_categories WHERE show_list_price=1"
        )
    }


def list_prices_for_sale(connection, categories):
    prices = category_list_prices(connection)
    return {category: prices[category] for category in sorted(set(categories) & prices.keys())}
