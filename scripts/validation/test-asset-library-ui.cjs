#!/usr/bin/env node
"use strict";

const fs = require("node:fs");
const path = require("node:path");

const root = path.resolve(
  __dirname,
  "..",
  ".."
);

function read(relativePath) {
  return fs.readFileSync(
    path.join(root, relativePath),
    "utf8"
  );
}

function assertIncludes(
  content,
  marker,
  message
) {
  if (!content.includes(marker)) {
    throw new Error(message);
  }
}

const component =
  read(
    "app/frontend/src/components/AssetLibrary.jsx"
  );

const app =
  read(
    "app/frontend/src/App.jsx"
  );

const sidebar =
  read(
    "app/frontend/src/components/Sidebar.jsx"
  );

const styles =
  read(
    "app/frontend/src/App.css"
  );

const api =
  read(
    "app/frontend/src/services/api.js"
  );

const server =
  read(
    "scripts/server/serve.cjs"
  );

assertIncludes(
  component,
  "listAssets",
  "Asset Library must use the existing Asset API service."
);

assertIncludes(
  component,
  "favoriteOnly",
  "Asset Library must expose favorite filtering."
);

assertIncludes(
  component,
  "projectFilter",
  "Asset Library must expose project filtering."
);

assertIncludes(
  component,
  "campaignFilter",
  "Asset Library must expose campaign filtering."
);

assertIncludes(
  component,
  "tagFilter",
  "Asset Library must expose tag filtering."
);

assertIncludes(
  component,
  "clearMetadataFilters",
  "Asset Library must allow metadata filters to be cleared."
);

assertIncludes(
  component,
  "getAssetSearchText",
  "Asset Library must centralize searchable asset fields."
);

assertIncludes(
  component,
  "asset.metadata?.originalName",
  "Asset Library search must include original metadata names."
);

assertIncludes(
  component,
  "asset.metadata?.mimeType",
  "Asset Library search must include metadata MIME types."
);

assertIncludes(
  component,
  "asset.storageProviderId",
  "Asset Library search must include storage provider IDs."
);

assertIncludes(
  component,
  "asset.relations",
  "Asset Library search must include relationship metadata."
);

assertIncludes(
  component,
  "libraryStats",
  "Asset Library must expose read-only summary stats."
);

assertIncludes(
  component,
  "asset-library-summary-strip",
  "Asset Library must render a summary strip."
);

assertIncludes(
  component,
  "relationshipCount",
  "Asset Library summary must include relationship counts."
);

assertIncludes(
  component,
  "ASSET_SORT_MODES",
  "Asset Library must expose sort modes."
);

assertIncludes(
  component,
  "sortAssets",
  "Asset Library must sort loaded assets client-side."
);

assertIncludes(
  component,
  "sortedAssets",
  "Asset Library must render sorted assets."
);

assertIncludes(
  component,
  "updated-desc",
  "Asset Library must support newest-first sorting."
);

assertIncludes(
  component,
  "ASSET_TYPES",
  "Asset Library must expose asset type filters."
);

assertIncludes(
  component,
  "relationCount",
  "Asset Library must show relationship visibility."
);

assertIncludes(
  component,
  "derivedCount",
  "Asset Library cards must show derived relationship counts."
);

assertIncludes(
  component,
  "referenceCount",
  "Asset Library cards must show reference relationship counts."
);

assertIncludes(
  component,
  "asset-library-relationship-summary",
  "Asset Library cards must show split relationship summaries."
);

assertIncludes(
  component,
  "AssetDetailPanel",
  "Asset Library must expose a read-only asset detail surface."
);

assertIncludes(
  component,
  "asset-library-card-selected",
  "Asset Library must visually mark the selected detail card."
);

assertIncludes(
  component,
  "aria-current",
  "Asset Library selected card must expose current state accessibly."
);

assertIncludes(
  component,
  "existingPath",
  "Asset Library must show the registered asset path."
);

assertIncludes(
  component,
  "sourcePrompt",
  "Asset detail must show the source prompt."
);

assertIncludes(
  component,
  "sourceModel",
  "Asset detail must show the source model."
);

assertIncludes(
  component,
  "asset-library-source-context",
  "Asset Library cards must show source prompt/model context."
);

assertIncludes(
  component,
  "asset-library-tag-overflow",
  "Asset Library cards must show hidden tag counts."
);

assertIncludes(
  component,
  "length - 3",
  "Asset Library hidden tag count must reflect tags beyond the visible chip limit."
);

assertIncludes(
  component,
  "storageProviderId",
  "Asset detail must show storage provider metadata."
);

assertIncludes(
  component,
  "createdAt",
  "Asset detail must show creation timestamps."
);

assertIncludes(
  component,
  "updatedAt",
  "Asset detail must show update timestamps."
);

assertIncludes(
  component,
  "JSON.stringify(asset.metadata",
  "Asset detail must show full metadata."
);

assertIncludes(
  component,
  "AssetRelationships",
  "Asset detail must show asset relationships."
);

assertIncludes(
  app,
  "LUKE_AI_ASSET_LIBRARY_UI_V1",
  "Asset Library marker is missing from App."
);

assertIncludes(
  app,
  '<AssetLibrary />',
  "Asset Library is not mounted in the App."
);

assertIncludes(
  app,
  'activeTab === "assets"',
  "Asset Library tab route is missing."
);

assertIncludes(
  sidebar,
  'setActiveTab("assets")',
  "Asset Library navigation item is missing."
);

assertIncludes(
  styles,
  "LUKE_AI_ASSET_LIBRARY_STYLES_V1",
  "Asset Library styles are missing."
);

assertIncludes(
  styles,
  "asset-library-filter-grid",
  "Asset Library metadata filter styles are missing."
);

assertIncludes(
  styles,
  "asset-library-summary-strip",
  "Asset Library summary strip styles are missing."
);

assertIncludes(
  styles,
  "asset-library-sort",
  "Asset Library sort styles are missing."
);

assertIncludes(
  styles,
  "asset-library-source-context",
  "Asset Library source context styles are missing."
);

assertIncludes(
  styles,
  "asset-library-relationship-summary",
  "Asset Library relationship summary styles are missing."
);

assertIncludes(
  styles,
  "asset-library-tag-overflow",
  "Asset Library hidden tag count styles are missing."
);

assertIncludes(
  styles,
  "asset-library-card-selected",
  "Asset Library selected-card styles are missing."
);

assertIncludes(
  api,
  "export function listAssets",
  "listAssets service is missing."
);

assertIncludes(
  server,
  "LUKE_AI_ASSET_REGISTRY_API_V1",
  "Asset Registry API marker is missing."
);

assertIncludes(
  server,
  'assetUrl.pathname ===\n        "/api/assets"',
  "GET /api/assets route is missing."
);

if (
  component.includes("deleteAsset(") ||
  component.includes("updateAsset(") ||
  component.includes("createAsset(")
) {
  throw new Error(
    "Asset Library must remain read-only in this phase."
  );
}

console.log(
  "PASS: Asset Library uses existing Asset API."
);
console.log(
  "PASS: Asset Library filters by type and favorites."
);
console.log(
  "PASS: Asset Library filters by project, campaign and tag."
);
console.log(
  "PASS: Asset Library search covers metadata and relationships."
);
console.log(
  "PASS: Asset Library shows read-only summary stats."
);
console.log(
  "PASS: Asset Library sorts loaded assets read-only."
);
console.log(
  "PASS: Asset Library cards show source prompt/model context."
);
console.log(
  "PASS: Asset Library cards show split relationship counts."
);
console.log(
  "PASS: Asset Library cards show hidden tag counts."
);
console.log(
  "PASS: Asset Library highlights the selected detail card."
);
console.log(
  "PASS: Asset Library shows paths and relationship counts."
);
console.log(
  "PASS: Asset Library detail shows full read-only asset metadata."
);
console.log(
  "PASS: Asset Library is connected to navigation."
);
console.log(
  "PASS: Asset Library remains read-only."
);
console.log(
  "PASS: Phase 3A-5D Asset Library UI validation completed."
);
