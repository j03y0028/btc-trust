#!/bin/bash
# Build the myNode package: per-arch docker images saved into mynode/btctrust/app_data/, then one tarball in build/.
#   scripts/package-mynode.sh            # amd64 + arm64 (arm64 via buildx + QEMU binfmt)
#   ARCHS="amd64" scripts/package-mynode.sh
# Needs docker with buildx. For arm64 on an x86 box register QEMU first, e.g.
#   docker run --privileged --rm tonistiigi/binfmt --install arm64   (or apt install qemu-user-static binfmt-support)
set -euo pipefail
cd "$(dirname "$0")/.."
VERSION="$(node -p 'require("./backend/package.json").version')"
ARCHS="${ARCHS:-amd64 arm64}"
DOCKER="${DOCKER:-docker}"
APPDIR=mynode/btctrust
OUT="build/btctrust-mynode-v$VERSION"
rm -f "$APPDIR"/app_data/btctrust-image-*.tar.gz*
for a in $ARCHS; do
    case "$a" in amd64) m=x86_64 ;; arm64) m=aarch64 ;; *) echo "bad arch $a" >&2; exit 2 ;; esac
    tag="btctrust:$VERSION-$a"
    echo "== building $tag"
    $DOCKER buildx build --platform "linux/$a" --load -t "$tag" .
    echo "== saving $APPDIR/app_data/btctrust-image-$m.tar.gz"
    $DOCKER save "$tag" | gzip -6 > "$APPDIR/app_data/btctrust-image-$m.tar.gz"
    (cd "$APPDIR/app_data" && sha256sum "btctrust-image-$m.tar.gz" > "btctrust-image-$m.tar.gz.sha256")
done
rm -rf "$OUT"; mkdir -p "$OUT/docs"
cp -r "$APPDIR" "$OUT/btctrust"
cp mynode/install-mynode.sh mynode/uninstall-mynode.sh "$OUT/"
cp docs/mynode-install.md "$OUT/docs/"
cp docker-compose.yml btctrust.env.example "$OUT/"
(cd build && tar czf "btctrust-mynode-v$VERSION.tar.gz" "btctrust-mynode-v$VERSION" && sha256sum "btctrust-mynode-v$VERSION.tar.gz" > "btctrust-mynode-v$VERSION.tar.gz.sha256")
# x86_64-only bundle (smaller download for x86 PCs): same contents without the arm64 image
if [ -f "$OUT/btctrust/app_data/btctrust-image-x86_64.tar.gz" ]; then
    rm -rf build/x86 && mkdir -p build/x86 && cp -a "$OUT" build/x86/
    rm -f build/x86/"btctrust-mynode-v$VERSION"/btctrust/app_data/btctrust-image-aarch64.tar.gz*
    (cd build/x86 && tar czf "btctrust-mynode-v$VERSION-x86_64.tar.gz" "btctrust-mynode-v$VERSION" \
        && sha256sum "btctrust-mynode-v$VERSION-x86_64.tar.gz" > "btctrust-mynode-v$VERSION-x86_64.tar.gz.sha256")
fi
ls -lh build/*.tar.gz build/x86/*.tar.gz 2>/dev/null; cat build/*.sha256 build/x86/*.sha256 2>/dev/null
