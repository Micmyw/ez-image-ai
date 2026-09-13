# Locale key parity

Use when checking locale-key structure. Limit `scopes` to the affected app/mail scopes; adding a locale requires every maintained scope. Run the JavaScript with Node using shell-appropriate syntax. This check complements rendering checks for interpolation and plurals.

```bash
   node --input-type=module <<'NODE'
   import { readFile } from "node:fs/promises";

   const locales = ["en", "de", "es", "fr"];
   const scopes = ["shared", "saas", "mail"];
   const flattenKeys = (value, prefix = "") =>
     Object.entries(value).flatMap(([key, child]) => {
       const path = prefix ? `${prefix}.${key}` : key;
       return child && typeof child === "object" ? flattenKeys(child, path) : [path];
     });
   const missingKeys = [];

   for (const scope of scopes) {
     const english = JSON.parse(
       await readFile(`packages/i18n/translations/en/${scope}.json`, "utf8"),
     );
     const expectedKeys = flattenKeys(english);
     for (const locale of locales.slice(1)) {
       const translated = JSON.parse(
         await readFile(`packages/i18n/translations/${locale}/${scope}.json`, "utf8"),
       );
       const translatedKeys = new Set(flattenKeys(translated));
       for (const key of expectedKeys) {
         if (!translatedKeys.has(key)) missingKeys.push(`${locale}/${scope}: ${key}`);
       }
     }
   }

   if (missingKeys.length) {
     console.error(missingKeys.join("\n"));
     process.exitCode = 1;
   }
   NODE
```
