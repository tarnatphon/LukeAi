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

export default function AssetLibrary() {
  const [assets, setAssets] = useState([]);
  const [activeType, setActiveType] = useState("all");
  const [favoriteOnly, setFavoriteOnly] = useState(false);
  const [query, setQuery] = useState("");
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState("");

  const loadAssets = useCallback(async () => {
    setIsLoading(true);
    setError("");

    try {
      const result = await listAssets({
        type: activeType === "all" ? "" : activeType,
        favorite: favoriteOnly ? true : "",
      });

      setAssets(Array.isArray(result.assets) ? result.assets : []);
    } catch (err) {
      setError(err?.message || "Asset Library could not be loaded.");
    } finally {
      setIsLoading(false);
    }
  }, [activeType, favoriteOnly]);

  useEffect(() => {
    loadAssets();
  }, [loadAssets]);

  const filteredAssets = useMemo(() => {
    const needle = query.trim().toLowerCase();
    if (!needle) return assets;

    return assets.filter((asset) => {
      const haystack = [
        asset.assetId,
        asset.type,
        asset.existingPath,
        asset.project,
        asset.campaign,
        asset.sourcePrompt,
        asset.sourceModel,
        ...(asset.tags || []),
      ]
        .filter(Boolean)
        .join(" ")
        .toLowerCase();

      return haystack.includes(needle);
    });
  }, [assets, query]);

  const summary = useMemo(() => {
    const counts = new Map();
    for (const asset of assets) {
      counts.set(asset.type, (counts.get(asset.type) || 0) + 1);
    }
    return counts;
  }, [assets]);

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

      {!isLoading && !error && filteredAssets.length > 0 && (
        <div className="asset-library-grid">
          {filteredAssets.map((asset) => {
            const Icon = getAssetIcon(asset.type);
            const relationCount =
              (asset.derivedFrom?.length || 0) +
              (asset.references?.length || 0) +
              (asset.relations?.length || 0);

            return (
              <article className="asset-library-card" key={asset.assetId}>
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

                {(asset.project || asset.campaign || asset.tags?.length > 0) && (
                  <div className="asset-library-tags">
                    {asset.project && <span>{asset.project}</span>}
                    {asset.campaign && <span>{asset.campaign}</span>}
                    {(asset.tags || []).slice(0, 3).map((tag) => (
                      <span key={tag}>{tag}</span>
                    ))}
                  </div>
                )}

                <footer>
                  <span title={asset.assetId}>{asset.assetId}</span>
                  <span>
                    <Link2 size={13} />
                    {relationCount}
                  </span>
                </footer>
              </article>
            );
          })}
        </div>
      )}
    </section>
  );
}
