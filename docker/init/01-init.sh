#!/bin/bash
set -e

echo "Aplicando schema_actualizado.sql..."
grep -v '\\restrict\|\\unrestrict' /schema/schema_actualizado.sql | \
    sed "s/OWNER TO postgres/OWNER TO $POSTGRES_USER/g" | \
    psql -v ON_ERROR_STOP=1 -U "$POSTGRES_USER" -d "$POSTGRES_DB"
