SET LOCAL search_path TO app_private, public;
ALTER TABLE products ADD CONSTRAINT product_source_fk FOREIGN KEY(source_id) REFERENCES sources(id);
ALTER TABLE products ADD CONSTRAINT product_supplier_fk FOREIGN KEY(supplier_id) REFERENCES suppliers(id);
ALTER TABLE sessions ADD CONSTRAINT session_kind CHECK(kind IN ('admin','anon'));
ALTER TABLE sessions ADD CONSTRAINT session_expiry_positive CHECK(expires_at>0);
ALTER TABLE rate_limits ADD CONSTRAINT rate_count_positive CHECK(count>0 AND reset_at>0);
ALTER TABLE quotes ADD CONSTRAINT quote_safe_total CHECK(
  NOT (json::jsonb ? 'total') OR (
    (json::jsonb->>'total')::numeric BETWEEN 0 AND 9007199254740991 AND
    (json::jsonb->>'total')::numeric=trunc((json::jsonb->>'total')::numeric)
  )
);
ALTER TABLE orders ADD CONSTRAINT order_safe_total CHECK(
  NOT (json::jsonb ? 'total') OR (
    (json::jsonb->>'total')::numeric BETWEEN 0 AND 9007199254740991 AND
    (json::jsonb->>'total')::numeric=trunc((json::jsonb->>'total')::numeric)
  )
);
