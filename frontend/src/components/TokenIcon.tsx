import { useEffect, useState } from "react";
import { CircleDollarSign } from "lucide-react";
import { getTokenMetadata } from "../api/client";

type TokenIconProps = {
  mint: string;
  symbol: string;
  tokenImage?: string;
};

const tokenImageCache = new Map<string, string | null>();

export function TokenIcon({ mint, symbol, tokenImage }: TokenIconProps) {
  const [image, setImage] = useState(() => tokenImage || tokenImageCache.get(mint));
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    let cancelled = false;
    setFailed(false);

    if (tokenImage) {
      tokenImageCache.set(mint, tokenImage);
      setImage(tokenImage);
      return;
    }

    if (tokenImageCache.has(mint)) {
      setImage(tokenImageCache.get(mint));
      return;
    }

    setImage(undefined);
    getTokenMetadata(mint)
      .then((metadata) => {
        const nextImage = metadata.image || null;
        tokenImageCache.set(mint, nextImage);
        if (!cancelled) setImage(nextImage);
      })
      .catch(() => {
        tokenImageCache.set(mint, null);
        if (!cancelled) setImage(null);
      });

    return () => {
      cancelled = true;
    };
  }, [mint, tokenImage]);

  if (image && !failed) {
    return (
      <div className="token-icon has-image">
        <img
          src={image}
          alt={symbol}
          loading="lazy"
          onError={() => {
            tokenImageCache.set(mint, null);
            setFailed(true);
          }}
        />
      </div>
    );
  }

  return (
    <div className="token-icon" title={symbol}>
      <CircleDollarSign size={18} />
    </div>
  );
}
