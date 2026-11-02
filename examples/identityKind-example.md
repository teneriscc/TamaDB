# identityKind Examples

This file shows how `identityKind` annotations in a Master_Schema define the Document_Identifier (D-Id) extraction from payloads.

## Example 1: Single Key

A simple Document_Type where one field is the D-Id.

**Master_Schema:**
```json
{
  "$schema": "http://json-schema.org/draft-07/schema#",
  "type": "object",
  "properties": {
    "sensorId": {
      "type": "string",
      "identityKind": "primary-key"
    },
    "temperature": {
      "type": "number"
    },
    "humidity": {
      "type": "number"
    },
    "location": {
      "type": "string"
    }
  },
  "required": ["sensorId", "temperature"]
}
```

**Sample payload:**
```json
{
  "sensorId": "sensor-hallway-01",
  "temperature": 22.5,
  "humidity": 45,
  "location": "Building A, Floor 2"
}
```

**Extracted D-Id:**
```json
{ "type": "single", "value": "sensor-hallway-01" }
```

---

## Example 2: Composed Key (parent + primary)

A Document_Type where the D-Id is composed of a parent key and a primary key (hierarchical relationship: customer → order).

**Master_Schema:**
```json
{
  "$schema": "http://json-schema.org/draft-07/schema#",
  "type": "object",
  "properties": {
    "customerId": {
      "type": "string",
      "identityKind": "parent-key"
    },
    "orderId": {
      "type": "string",
      "identityKind": "primary-key"
    },
    "orderDate": {
      "type": "string",
      "format": "date"
    },
    "totalAmount": {
      "type": "number",
      "minimum": 0
    },
    "items": {
      "type": "array",
      "items": {
        "type": "object",
        "properties": {
          "productId": { "type": "string" },
          "quantity": { "type": "integer", "minimum": 1 },
          "price": { "type": "number" }
        },
        "required": ["productId", "quantity", "price"]
      }
    }
  },
  "required": ["customerId", "orderId", "orderDate", "totalAmount"]
}
```

**Sample payload:**
```json
{
  "customerId": "customer-ABC",
  "orderId": "order-2026-00142",
  "orderDate": "2026-06-13",
  "totalAmount": 249.99,
  "items": [
    { "productId": "PROD-001", "quantity": 2, "price": 99.99 },
    { "productId": "PROD-007", "quantity": 1, "price": 50.01 }
  ]
}
```

**Extracted D-Id:**
```json
{ "type": "composed", "parts": ["customer-ABC", "order-2026-00142"] }
```

**URL representation:** `/api/v1/documents/customer-ABC:order-2026-00142`

---

## Example 3: Multiple Parent Keys

A Document_Type with multiple levels of hierarchy (two parent keys + one primary key).

**Master_Schema:**
```json
{
  "$schema": "http://json-schema.org/draft-07/schema#",
  "type": "object",
  "properties": {
    "region": {
      "type": "string",
      "identityKind": "parent-key"
    },
    "storeId": {
      "type": "string",
      "identityKind": "parent-key"
    },
    "transactionId": {
      "type": "string",
      "identityKind": "primary-key"
    },
    "timestamp": {
      "type": "string",
      "format": "date-time"
    },
    "amount": {
      "type": "number"
    },
    "paymentMethod": {
      "type": "string",
      "enum": ["card", "cash", "mobile"]
    }
  },
  "required": ["region", "storeId", "transactionId", "timestamp", "amount"]
}
```

**Sample payload:**
```json
{
  "region": "EU-NORTH",
  "storeId": "store-stockholm-central",
  "transactionId": "txn-20260613-98765",
  "timestamp": "2026-06-13T14:30:00Z",
  "amount": 159.00,
  "paymentMethod": "card"
}
```

**Extracted D-Id:**
```json
{ "type": "composed", "parts": ["EU-NORTH", "store-stockholm-central", "txn-20260613-98765"] }
```

**URL representation:** `/api/v1/documents/EU-NORTH:store-stockholm-central:txn-20260613-98765`

**Note:** Parent keys appear in declaration order before the primary key. The composed D-Id preserves the hierarchy: region → store → transaction.

---

## Example 4: Nested Identity Fields (real-world payload)

Identity fields do not have to be top-level. `identityKind` can annotate a property at any object-nesting depth; TamaDB discovers it by descending through nested objects (and resolving `$ref`). This is the common case for real business documents. Below is a simplified consignment whose identity is `Identifier.CreatorReference.BusinessUnitCode` + `Identifier.CreatorReference.BusinessUnitType` (parent) then `Identifier.Number` (primary).

**Master_Schema (excerpt):**
```json
{
  "$schema": "http://json-schema.org/draft-07/schema#",
  "type": "object",
  "properties": {
    "Identifier": {
      "type": "object",
      "properties": {
        "CreatorReference": {
          "type": "object",
          "properties": {
            "BusinessUnitCode": { "type": "string", "identityKind": "parent-key" },
            "BusinessUnitType": { "type": "string", "identityKind": "parent-key" }
          }
        },
        "Number": { "type": "string", "identityKind": "primary-key" }
      }
    }
  }
}
```

**Sample payload:**
```json
{
  "Identifier": {
    "CreatorReference": { "BusinessUnitCode": "22648", "BusinessUnitType": "SUP" },
    "Number": "ECIS34549"
  }
}
```

**Extracted D-Id:**
```json
{ "type": "composed", "parts": ["22648", "SUP", "ECIS34549"] }
```

**URL representation:** `/api/v1/documents/{documentType}/22648:SUP:ECIS34549`

**Notes:**
- Each identity field is located by its **Identity_Path** (e.g. `Identifier.Number`). The annotated value must be a **scalar** — annotating the `Identifier` object itself would be rejected at store time with `IDENTITY_FIELD_NOT_SCALAR`.
- **Arrays are never traversed.** An `identityKind` placed inside an array element is not discovered (arrays are atomic in Increment 1).
- Assembly order is parent-keys first, then primary-keys, in the order discovered depth-first through the schema.

---

## Key Rules

1. `identityKind` is a JSON Schema Draft 7 annotation keyword — unknown to standard validators, read by TamaDB
2. Values: `"primary-key"` (the main identifier) and `"parent-key"` (hierarchical parent component)
3. A schema may have **one or more** `primary-key` fields and zero or more `parent-key` fields
4. Annotations may appear at **any object-nesting depth**; each field is addressed by its Identity_Path (root-to-leaf property segments). Arrays are not traversed. The annotated value must resolve to a scalar
5. Fields are assembled in **discovery order** — a depth-first traversal of object properties in declaration order — with parent-keys before primary-keys
6. Composed D-Id parts are percent-encoded in URLs, so a part value may contain the `:` delimiter or `/` without breaking addressing
7. If both `identityKind` annotations and metadata D-Id definition exist, annotations take precedence
8. If neither is provided for a DCM/HDOM Master_Schema, TamaDB rejects the schema registration
