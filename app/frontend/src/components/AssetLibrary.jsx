import { useCallback, useEffect, useMemo, useState } from "react";
import {
  Archive,
  Box,
  Film,
  Image,
  Link2,
  RefreshCw,
  Search,
  Star,
  X,
} from "lucide-react";
import { listAssets } from "../services/api";

const ASSET_TYPES = [
  "all",
  "image",
  "video",
  "reference",
  "prompt",
  "brand",
  "logo",
  "voice",
  "music",
];

const ASSET_SORT_MODES = [
  {
    value: "updated-desc",
    label: "Newest",
  },
  {
    value: "updated-asc",
    label: "Oldest",
  },
  {
    value: "title-asc",
    label: "Title",
  },
  {
    value: "type-asc",
    label: "Type",
  },
];

function formatAssetDate(value) {
  if (!value) return "Not recorded";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "Not recorded";
  return date.toLocaleString([], {
    dateStyle: "medium",
    timeStyle: "short",
  });
}

function formatAssetPath(value) {
  if (!value) return "Managed record only";
  const parts = String(value).split(/[\\/]/).filter(Boolean);
  if (parts.length <= 3) return value;
  return `.../${parts.slice(-3).join("/")}`;
}

function getAssetIcon(type) {
  if (type === "image" || type === "reference" || type === "logo") return Image;
  if (type === "video") return Film;
  if (type === "brand") return Archive;
  return Box;
}

function getAssetTitle(asset) {
  return (
    asset.metadata?.originalName ||
    asset.metadata?.filename ||
    asset.metadata?.title ||
    asset.sourcePrompt ||
    asset.existingPath?.split(/[\\/]/).pop() ||
    asset.assetId
  );
}

function getAssetSearchText(asset) {
  return [
    asset.assetId,
    asset.type,
    asset.existingPath,
    asset.project,
    asset.campaign,
    asset.sourcePrompt,
    asset.sourceModel,
    asset.storageProviderId,
    asset.metadata?.originalName,
    asset.metadata?.filename,
    asset.metadata?.title,
    asset.metadata?.mimeType,
    asset.metadata?.source,
    ...(asset.tags || []),
    ...(asset.derivedFrom || []),
    ...(asset.references || []),
    ...(asset.relations || []).flatMap((item) => [
      item.assetId,
      item.relation,
    ]),
  ]
    .filter(Boolean)
    .join(" ")
    .toLowerCase();
}

function getAssetTime(asset) {
  const time =
    Date.parse(asset.updatedAt || asset.createdAt || "");

  return Number.isFinite(time) ? time : 0;
}

function sortAssets(assets, sortMode) {
  const sortedAssets = [...assets];

  sortedAssets.sort((left, right) => {
    if (sortMode === "updated-asc") {
      return getAssetTime(left) - getAssetTime(right);
    }

    if (sortMode === "title-asc") {
      return getAssetTitle(left).localeCompare(getAssetTitle(right));
    }

    if (sortMode === "type-asc") {
      return (
        String(left.type || "").localeCompare(String(right.type || "")) ||
        getAssetTitle(left).localeCompare(getAssetTitle(right))
      );
    }

    return getAssetTime(right) - getAssetTime(left);
  });

  return sortedAssets;
}

function formatAssetValue(value) {
  if (value === undefined || value === null || value === "") {
    return "Not recorded";
  }

  if (typeof value === "boolean") {
    return value ? "Yes" : "No";
  }

  return String(value);
}

function AssetDetailRow({ label, children }) {
  return (
    <div className="asset-library-detail-row">
      <dt>{label}</dt>
      <dd>{children}</dd>
    </div>
  );
}

function AssetDetailList({ title, items = [] }) {
  return (
    <section className="asset-library-detail-section">
      <h4>{title}</h4>
      {items.length > 0 ? (
        <div className="asset-library-detail-tags">
          {items.map((item) => (
            <span key={item}>{item}</span>
          ))}
        </div>
      ) : (
        <p>None recorded</p>
      )}
    </section>
  );
}

function AssetRelationships({ asset }) {
  const relationEntries = [
    ...((asset.derivedFrom || []).map((assetId) => ({
      label: "Derived from",
      value: assetId,
    }))),
    ...((asset.references || []).map((assetId) => ({
      label: "References",
      value: assetId,
    }))),
    ...((asset.relations || []).map((item) => ({
      label: item.relation,
      value: item.assetId,
    }))),
  ];

  return (
    <section className="asset-library-detail-section">
      <h4>Relationships</h4>
      {relationEntries.length > 0 ? (
        <dl className="asset-library-relationships">
          {relationEntries.map((item, index) => (
            <div key={`${item.label}-${item.value}-${index}`}>
              <dt>{item.label}</dt>
              <dd>{item.value}</dd>
            </div>
          ))}
        </dl>
      ) : (
        <p>None recorded</p>
      )}
    </section>
  );
}

function AssetDetailPanel({ asset, onClose }) {
  if (!asset) return null;

  const metadata =
    asset.metadata &&
    Object.keys(asset.metadata).length > 0
      ? JSON.stringify(asset.metadata, null, 2)
      : "None recorded";

  return (
    <aside
      className="asset-library-detail"
      aria-label="Asset detail"
    >
      <header>
        <div>
          <span className={`asset-library-type asset-library-type-${asset.type}`}>
            {asset.type}
          </span>
          <h3>{getAssetTitle(asset)}</h3>
        </div>
        <button
          type="button"
          className="asset-library-icon-button"
          onClick={onClose}
          title="Close asset detail"
          aria-label="Close asset detail"
        >
          <X size={16} />
        </button>
      </header>

      <dl className="asset-library-detail-grid">
        <AssetDetailRow label="Asset ID">
          {asset.assetId}
        </AssetDetailRow>
        <AssetDetailRow label="Type">
          {formatAssetValue(asset.type)}
        </AssetDetailRow>
        <AssetDetailRow label="Existing path">
          {formatAssetValue(asset.existingPath)}
        </AssetDetailRow>
        <AssetDetailRow label="Storage provider">
          {formatAssetValue(asset.storageProviderId || "local")}
        </AssetDetailRow>
        <AssetDetailRow label="Created">
          {formatAssetDate(asset.createdAt)}
        </AssetDetailRow>
        <AssetDetailRow label="Updated">
          {formatAssetDate(asset.updatedAt)}
        </AssetDetailRow>
        <AssetDetailRow label="Project">
          {formatAssetValue(asset.project)}
        </AssetDetailRow>
        <AssetDetailRow label="Campaign">
          {formatAssetValue(asset.campaign)}
        </AssetDetailRow>
        <AssetDetailRow label="Favorite">
          {formatAssetValue(asset.favorite)}
        </AssetDetailRow>
        <AssetDetailRow label="Pinned">
          {formatAssetValue(asset.pinned)}
        </AssetDetailRow>
        <AssetDetailRow label="Source model">
          {formatAssetValue(asset.sourceModel)}
        </AssetDetailRow>
        <AssetDetailRow label="Source prompt">
          {formatAssetValue(asset.sourcePrompt)}
        </AssetDetailRow>
      </dl>

      <AssetDetailList
        title="Tags"
        items={asset.tags || []}
      />
      <AssetRelationships asset={asset} />

      <section className="asset-library-detail-section">
        <h4>Metadata</h4>
        <pre>{metadata}</pre>
      </section>
    </aside>
  );
}

export default function AssetLibrary() {
  const [assets, setAssets] = useState([]);
  const [activeType, setActiveType] = useState("all");
  const [favoriteOnly, setFavoriteOnly] = useState(false);
  const [projectFilter, setProjectFilter] = useState("");
  const [campaignFilter, setCampaignFilter] = useState("");
  const [tagFilter, setTagFilter] = useState("");
  const [sortMode, setSortMode] = useState("updated-desc");
  const [query, setQuery] = useState("");
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState("");
  const [selectedAssetId, setSelectedAssetId] = useState("");

  const loadAssets = useCallback(async () => {
    setIsLoading(true);
    setError("");

    try {
      const result = await listAssets({
        type: activeType === "all" ? "" : activeType,
        favorite: favoriteOnly ? true : "",
        project: projectFilter.trim(),
        campaign: campaignFilter.trim(),
        tag: tagFilter.trim(),
      });

      setAssets(Array.isArray(result.assets) ? result.assets : []);
    } catch (err) {
      setError(err?.message || "Asset Library could not be loaded.");
    } finally {
      setIsLoading(false);
    }
  }, [activeType, campaignFilter, favoriteOnly, projectFilter, tagFilter]);

  useEffect(() => {
    loadAssets();
  }, [loadAssets]);

  const filteredAssets = useMemo(() => {
    const needle = query.trim().toLowerCase();
    if (!needle) return assets;

    return assets.filter((asset) => {
      return getAssetSearchText(asset).includes(needle);
    });
  }, [assets, query]);

  const sortedAssets = useMemo(
    () => sortAssets(filteredAssets, sortMode),
    [filteredAssets, sortMode]
  );

  const summary = useMemo(() => {
    const counts = new Map();
    for (const asset of assets) {
      counts.set(asset.type, (counts.get(asset.type) || 0) + 1);
    }
    return counts;
  }, [assets]);

  const libraryStats = useMemo(() => {
    let favoriteCount = 0;
    let relationshipCount = 0;

    for (const asset of assets) {
      if (asset.favorite) favoriteCount += 1;

      relationshipCount +=
        (asset.derivedFrom?.length || 0) +
        (asset.references?.length || 0) +
        (asset.relations?.length || 0);
    }

    return {
      total: assets.length,
      visible: filteredAssets.length,
      favoriteCount,
      relationshipCount,
    };
  }, [assets, filteredAssets.length]);

  const selectedAsset = useMemo(
    () => assets.find((asset) => asset.assetId === selectedAssetId) || null,
    [assets, selectedAssetId]
  );

  const hasMetadataFilters =
    projectFilter.trim() ||
    campaignFilter.trim() ||
    tagFilter.trim();

  const clearMetadataFilters = () => {
    setProjectFilter("");
    setCampaignFilter("");
    setTagFilter("");
  };

  return (
    <section className="asset-library">
      <div className="asset-library-header">
        <div>
          <div className="asset-library-eyebrow">
            <Archive size={14} />
            <span>Asset Library</span>
          </div>
          <h2>Registered Assets</h2>
          <p>
            Browse generated images, videos and reference files already tracked by LUKE AI.
          </p>
        </div>

        <button
          type="button"
          className="m3-btn m3-btn-tonal"
          onClick={loadAssets}
          disabled={isLoading}
          title="Refresh Asset Library"
        >
          <RefreshCw size={16} />
          Refresh
        </button>
      </div>

      <div className="asset-library-toolbar">
        <div className="asset-library-search">
          <Search size={16} />
          <input
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="Search assets"
            aria-label="Search assets"
          />
        </div>

        <button
          type="button"
          className={`m3-btn ${favoriteOnly ? "m3-btn-filled" : "m3-btn-outlined"}`}
          onClick={() => setFavoriteOnly((value) => !value)}
        >
          <Star size={16} />
          Favorites
        </button>
      </div>

      <label className="asset-library-sort">
        <span>Sort</span>
        <select
          value={sortMode}
          onChange={(event) => setSortMode(event.target.value)}
          aria-label="Sort assets"
        >
          {ASSET_SORT_MODES.map((mode) => (
            <option key={mode.value} value={mode.value}>
              {mode.label}
            </option>
          ))}
        </select>
      </label>

      <div className="asset-library-filter-grid" aria-label="Asset metadata filters">
        <label>
          <span>Project</span>
          <input
            value={projectFilter}
            onChange={(event) => setProjectFilter(event.target.value)}
            placeholder="Any project"
          />
        </label>

        <label>
          <span>Campaign</span>
          <input
            value={campaignFilter}
            onChange={(event) => setCampaignFilter(event.target.value)}
            placeholder="Any campaign"
          />
        </label>

        <label>
          <span>Tag</span>
          <input
            value={tagFilter}
            onChange={(event) => setTagFilter(event.target.value)}
            placeholder="Any tag"
          />
        </label>

        <button
          type="button"
          className="m3-btn m3-btn-outlined"
          onClick={clearMetadataFilters}
          disabled={!hasMetadataFilters}
        >
          Clear
        </button>
      </div>

      <div className="asset-library-summary-strip" aria-label="Asset Library summary">
        <span>
          <strong>{libraryStats.total}</strong>
          Total
        </span>
        <span>
          <strong>{libraryStats.visible}</strong>
          Visible
        </span>
        <span>
          <strong>{libraryStats.favoriteCount}</strong>
          Favorites
        </span>
        <span>
          <strong>{libraryStats.relationshipCount}</strong>
          Links
        </span>
      </div>

      <div className="asset-library-tabs" aria-label="Asset type filters">
        {ASSET_TYPES.map((type) => (
          <button
            key={type}
            type="button"
            className={activeType === type ? "active" : ""}
            onClick={() => setActiveType(type)}
          >
            {type === "all" ? "All" : type}
            {type !== "all" && summary.has(type) && (
              <span>{summary.get(type)}</span>
            )}
          </button>
        ))}
      </div>

      {error && (
        <div className="asset-library-error">
          {error}
        </div>
      )}

      {isLoading && (
        <div className="asset-library-empty">
          Loading Asset Library...
        </div>
      )}

      {!isLoading && !error && filteredAssets.length === 0 && (
        <div className="asset-library-empty">
          No registered assets match this view.
        </div>
      )}

      {!isLoading && !error && sortedAssets.length > 0 && (
        <div className="asset-library-grid">
          {sortedAssets.map((asset) => {
            const Icon = getAssetIcon(asset.type);
            const derivedCount = asset.derivedFrom?.length || 0;
            const referenceCount = asset.references?.length || 0;
            const relationCount = asset.relations?.length || 0;
            const isSelected = selectedAssetId === asset.assetId;

            return (
              <article
                className={`asset-library-card ${isSelected ? "asset-library-card-selected" : ""}`}
                key={asset.assetId}
                aria-current={isSelected ? "true" : undefined}
              >
                <header>
                  <span className={`asset-library-type asset-library-type-${asset.type}`}>
                    <Icon size={15} />
                    {asset.type}
                  </span>
                  {asset.favorite && (
                    <span className="asset-library-favorite">
                      <Star size={14} />
                    </span>
                  )}
                </header>

                <h3 title={getAssetTitle(asset)}>
                  {getAssetTitle(asset)}
                </h3>

                <div className="asset-library-path" title={asset.existingPath || ""}>
                  {formatAssetPath(asset.existingPath)}
                </div>

                <div className="asset-library-meta">
                  <span>{formatAssetDate(asset.updatedAt || asset.createdAt)}</span>
                  <span>{asset.storageProviderId || "local"}</span>
                </div>

                {(asset.sourceModel || asset.sourcePrompt) && (
                  <div className="asset-library-source-context">
                    {asset.sourceModel && (
                      <span title={asset.sourceModel}>
                        {asset.sourceModel}
                      </span>
                    )}
                    {asset.sourcePrompt && (
                      <p title={asset.sourcePrompt}>
                        {asset.sourcePrompt}
                      </p>
                    )}
                  </div>
                )}

                {(asset.project || asset.campaign || asset.tags?.length > 0) && (
                  <div className="asset-library-tags">
                    {asset.project && <span>{asset.project}</span>}
                    {asset.campaign && <span>{asset.campaign}</span>}
                    {(asset.tags || []).slice(0, 3).map((tag) => (
                      <span key={tag}>{tag}</span>
                    ))}
                    {(asset.tags || []).length > 3 && (
                      <span
                        className="asset-library-tag-overflow"
                        title={(asset.tags || []).join(", ")}
                      >
                        +{(asset.tags || []).length - 3}
                      </span>
                    )}
                  </div>
                )}

                <footer>
                  <span title={asset.assetId}>{asset.assetId}</span>
                  <div className="asset-library-relationship-summary">
                    <span title="Derived-from links">
                      D {derivedCount}
                    </span>
                    <span title="Reference links">
                      R {referenceCount}
                    </span>
                    <span title="Other relationships">
                      L {relationCount}
                    </span>
                    <button
                      type="button"
                      className="asset-library-detail-trigger"
                      onClick={() => setSelectedAssetId(asset.assetId)}
                      aria-label={`View details for ${getAssetTitle(asset)}`}
                    >
                      <Link2 size={13} />
                      Details
                    </button>
                  </div>
                </footer>
              </article>
            );
          })}
        </div>
      )}

      <AssetDetailPanel
        asset={selectedAsset}
        onClose={() => setSelectedAssetId("")}
      />
    </section>
  );
}
