/**
 * tile.js — Squaremap 瓦片坐标转换（前端最关键的模块）
 *
 * 公式来源与验证：
 *   1. squaremap Java 端 (jpenilla/squaremap) RegionImage.java：
 *      瓦片为 512x512 像素，URL 为 {world}/{urlZoom}/{tileX}_{tileZ}.png，
 *      tileX = floorDiv(blockX, 512 * 2^(maxZoom - urlZoom))，即：
 *        - urlZoom = maxZoom(3) 时 1 格 = 1 像素，每瓦片覆盖 512 格
 *        - urlZoom = 0 时 8 格 = 1 像素，每瓦片覆盖 4096 格
 *   2. squaremap Web 端 Squaremap.js：
 *      toLatLng(x, z) = L.latLng(-z * scale, x * scale)，scale = 2^-zoom.max，
 *      crs 为 L.CRS.Simple，tileSize 512。
 *   3. Playwright 实测 squaremap demo（?world=world&zoom=3&x=16&z=-48）：
 *      zoom 3 与 zoom 0 请求的瓦片索引一致（3/0_-1.png 等），
 *      证实 1 格 = 1 像素（zoom 3）、8 格 = 1 像素（zoom 0），瓦片索引公式与 Java 端一致。
 *
 * 本实现采用 Leaflet 1.9.4 的 CRS.Simple 语义（scale(zoom) = 256 * 2^zoom）：
 *   px_per_block(zoom) = 256 * 2^zoom * latlngPerBlock = 2^(zoom - maxZoom)
 *   => latlngPerBlock = 1 / (256 * 2^maxZoom)
 *   地图 zoom 即服务器 urlZoom（0..maxZoom，之上为放大显示的 extra 层级）。
 */

const TileConfig = {
  tileSize: 512,        // 瓦片像素尺寸（squaremap 固定）
  maxZoom: 3,           // 服务器 zoom.max（世界 settings.json 中的 zoom.max）
  extraZoom: 2,         // 额外放大层级（settings.json 中的 zoom.extra），瓦片为原生层级放大
  offsetX: 0,           // 可配置偏移量（格），验证/校准公式时调整  TODO: verify
  offsetZ: 0,           // 可配置偏移量（格）                      TODO: verify
};

const CRS_SCALE_BASE = 256; // Leaflet 1.9.4 CRS.Simple: scale(zoom) = 256 * 2^zoom

/** 每个方块坐标对应的 Leaflet LatLng 单位数（latlngPerBlock = 1/(256*2^maxZoom)） */
function latlngPerBlock() {
  return 1 / (CRS_SCALE_BASE * Math.pow(2, TileConfig.maxZoom));
}

/**
 * Minecraft 方块坐标 → Leaflet LatLng
 * lat = -(z + offsetZ) * latlngPerBlock, lng = (x + offsetX) * latlngPerBlock
 */
function blockToLatLng(x, z) {
  const s = latlngPerBlock();
  return L.latLng(-(z + TileConfig.offsetZ) * s, (x + TileConfig.offsetX) * s);
}

/** Leaflet LatLng → Minecraft 方块坐标（blockToLatLng 的逆运算） */
function latLngToBlock(latlng) {
  const s = latlngPerBlock();
  return {
    x: latlng.lng / s - TileConfig.offsetX,
    z: -latlng.lat / s - TileConfig.offsetZ,
  };
}

/** 方块坐标 → 瓦片索引（与 Java 端 floorDiv(blockX, 512 * 2^(maxZoom - zoom)) 一致） */
function blockToTile(x, z, zoom) {
  const step = Math.pow(2, TileConfig.maxZoom - zoom);
  return {
    x: Math.floor((x + TileConfig.offsetX) / (TileConfig.tileSize * step)),
    z: Math.floor((z + TileConfig.offsetZ) / (TileConfig.tileSize * step)),
  };
}

/** 瓦片索引 → 该瓦片覆盖的方块范围 */
function tileToBlockRange(tileX, tileZ, zoom) {
  const step = Math.pow(2, TileConfig.maxZoom - zoom);
  const size = TileConfig.tileSize * step;
  return {
    minX: tileX * size - TileConfig.offsetX, maxX: (tileX + 1) * size - TileConfig.offsetX,
    minZ: tileZ * size - TileConfig.offsetZ, maxZ: (tileZ + 1) * size - TileConfig.offsetZ,
  };
}

/**
 * 自定义 CRS：显式固定 scale(zoom) = 256 * 2^zoom，
 * 避免 Leaflet 版本差异（如 Leaflet 2.x 的 CRS.Simple 使用 2^zoom）导致瓦片错位。
 */
const McMapCRS = L.extend({}, L.CRS.Simple, {
  scale: function (zoom) { return CRS_SCALE_BASE * Math.pow(2, zoom); },
  zoom: function (scale) { return Math.log(scale / CRS_SCALE_BASE) / Math.LN2; },
});

/**
 * 创建 Squaremap 瓦片图层。
 * @param {string} squaremapUrl 地图根地址，如 https://host/world-map
 * @param {string} template 瓦片 URL 模板，如 /tiles/{world}/{zoom}/{x}_{z}.png
 * @param {string} world 世界名，如 minecraft_overworld
 * @param {number} maxZoom 原生最大缩放等级（服务器 zoom.max）
 * @param {number} extraZoom 额外放大层级数
 */
function createSquaremapTileLayer(squaremapUrl, template, world, maxZoom, extraZoom) {
  const base = String(squaremapUrl || '').replace(/\/+$/, '');

  const SmTileLayer = L.TileLayer.extend({
    getTileUrl: function (coords) {
      // coords.z 已被 maxNativeZoom 钳制为原生缩放等级（0..maxZoom）
      const zoom = coords.z;
      const url = String(template || '/tiles/{world}/{zoom}/{x}_{z}.png')
        .replace(/\{world\}/g, encodeURIComponent(world))
        .replace(/\{zoom\}/g, zoom)
        .replace(/\{x\}/g, coords.x)
        .replace(/\{z\}/g, coords.y); // Leaflet 的 tile y 对应服务器的瓦片 Z
      return base + url;
    },
  });

  return new SmTileLayer('', {
    tileSize: TileConfig.tileSize,
    minNativeZoom: 0,
    maxNativeZoom: maxZoom,
    minZoom: 0,
    maxZoom: maxZoom + (extraZoom != null ? extraZoom : TileConfig.extraZoom),
    noWrap: true,
    keepBuffer: 2,
    // 瓦片加载失败时静默（地图空白区域无瓦片属正常）
    errorTileUrl: 'data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7',
  });
}
