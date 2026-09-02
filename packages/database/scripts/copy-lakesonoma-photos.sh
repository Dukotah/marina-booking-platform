#!/usr/bin/env bash
#
# Copy the real Lake Sonoma product photos from the client site into the API's
# local upload store, under the deterministic names the catalog seed wires up.
#
# The customer catalog (apps/web) and admin (apps/admin) render Activity.photo_urls
# as plain <img src>. Serving the bytes from the API's /uploads route (one stable
# origin) is what makes the same URL work on :3000 and :3002. The stored name must
# match services/storage.ts's isSafeStoredName (32 hex chars + extension), so we
# name each file md5(slug).jpg — exactly what seed-lakesonoma-catalog.ts computes.
#
# Idempotent: overwrites in place. Safe to re-run. No singenuity/cloudinary URL is
# ever written for this tenant — only local bytes served by our own API.
#
# Usage (from repo root):
#   bash packages/database/scripts/copy-lakesonoma-photos.sh
#
# Then wire them into the DB:
#   cd packages/database && node --experimental-strip-types scripts/seed-lakesonoma-catalog.ts
set -euo pipefail

SRC="${LAKESONOMA_PHOTO_SRC:-/mnt/c/Users/dukot/projects/LakeSonoma/public/images/singenuity}"

# Resolve repo root (dir holding pnpm-workspace.yaml), matching storage.ts.
here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
root="$here"
while [ "$root" != "/" ] && [ ! -f "$root/pnpm-workspace.yaml" ]; do root="$(dirname "$root")"; done
DEST="${SANDBOX_UPLOAD_DIR:-$root/.sandbox/uploads}/lsra/activity"
mkdir -p "$DEST"

# slug -> source singenuity jpg id. Quest reuses 3633 as its documented stand-in.
MAP="
pontoon-5-person:3624
pontoon-10-person:3633
pontoon-12-person:3634
pontoon-double-decker:3635
pontoon-premium-10:3636
quest-fishing-pontoon:3633
watersport-tubing:3637
premium-sport-boat:3627
logic-fishing-boat:3641
jet-ski:3643
single-kayak:3644
double-kayak:3645
paddle-board:3648
canoe:3650
patio-grand:3651
patio-bar:3652
patio-scenic:3653
patio-bridge:3654
patio-lakeside-5:3655
patio-lakeside-6:3656
patio-upper-lakeside-7:3657
"

count=0
while IFS=: read -r slug id; do
  [ -z "$slug" ] && continue
  hex="$(printf '%s' "$slug" | md5sum | cut -c1-32)"
  cp "$SRC/$id.jpg" "$DEST/$hex.jpg"
  count=$((count + 1))
done <<< "$MAP"

echo "Copied $count Lake Sonoma photos into $DEST"
