import { pictureToDataUrl } from "../lib/format";
import type { Picture } from "../lib/types";

export function Thumbnail({
  picture,
  alt,
  className,
}: {
  picture: Picture | null | undefined;
  alt: string;
  className?: string;
}) {
  const src = pictureToDataUrl(picture);
  if (!src) {
    return (
      <div className={`thumb thumb-empty ${className ?? ""}`} aria-label={alt}>
        <span>No image</span>
      </div>
    );
  }
  return <img className={`thumb ${className ?? ""}`} src={src} alt={alt} />;
}
