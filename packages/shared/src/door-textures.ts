/**
 * The door images Foundry 14 ships under `public/canvas/doors` (top-down edge views, 200 px per grid cell).
 * A door only animates when its wall has `animation.type` AND `animation.texture`, so every animated door
 * needs one of these (or a path of the caller's own). `small` images are one cell wide; `large` images
 * are 2x1 and meant for double doors and wide gates. Paths are relative to Foundry's public folder.
 */
export const DOOR_STYLES = ["wood", "stone", "metal", "portcullis"] as const;
export type DoorStyle = (typeof DOOR_STYLES)[number];

export interface DoorTexture {
  path: string;
  style: DoorStyle;
  /** The colour word from the file name: ashen, dark, light, red, walnut, earthy, redrock, volcanic, gray, rusty. */
  tone: string;
  /** True for the 2x1 images (double doors, wide gates). */
  wide: boolean;
}

export const DOOR_TEXTURES: readonly DoorTexture[] = [
  { path: "canvas/doors/small/Door_Metal_Gray_E1_1x1.webp", style: "metal", tone: "gray", wide: false },
  { path: "canvas/doors/small/Door_Metal_Rusty_D_1x1.webp", style: "metal", tone: "rusty", wide: false },
  { path: "canvas/doors/small/Door_Metal_Rusty_F_1x1.webp", style: "metal", tone: "rusty", wide: false },
  { path: "canvas/doors/small/Door_Stone_Earthy_A_1x1.webp", style: "stone", tone: "earthy", wide: false },
  { path: "canvas/doors/small/Door_Stone_Earthy_B1_1x1.webp", style: "stone", tone: "earthy", wide: false },
  { path: "canvas/doors/small/Door_Stone_Redrock_A_Rusty_1x1.webp", style: "stone", tone: "redrock", wide: false },
  { path: "canvas/doors/small/Door_Stone_Redrock_B1_1x1.webp", style: "stone", tone: "redrock", wide: false },
  { path: "canvas/doors/small/Door_Stone_Volcanic_A_1x1.webp", style: "stone", tone: "volcanic", wide: false },
  { path: "canvas/doors/small/Door_Stone_Volcanic_B1_1x1.webp", style: "stone", tone: "volcanic", wide: false },
  { path: "canvas/doors/small/Door_Wood_Ashen_A_1x1.webp", style: "wood", tone: "ashen", wide: false },
  { path: "canvas/doors/small/Door_Wood_Ashen_D_1x1.webp", style: "wood", tone: "ashen", wide: false },
  { path: "canvas/doors/small/Door_Wood_Ashen_E_1x1.webp", style: "wood", tone: "ashen", wide: false },
  { path: "canvas/doors/small/Door_Wood_Ashen_L_1x1.webp", style: "wood", tone: "ashen", wide: false },
  { path: "canvas/doors/small/Door_Wood_Dark_C_1x1.webp", style: "wood", tone: "dark", wide: false },
  { path: "canvas/doors/small/Door_Wood_Dark_H_1x1.webp", style: "wood", tone: "dark", wide: false },
  { path: "canvas/doors/small/Door_Wood_Dark_P_1x1.webp", style: "wood", tone: "dark", wide: false },
  { path: "canvas/doors/small/Door_Wood_Light_B_1x1.webp", style: "wood", tone: "light", wide: false },
  { path: "canvas/doors/small/Door_Wood_Light_G_1x1.webp", style: "wood", tone: "light", wide: false },
  { path: "canvas/doors/small/Door_Wood_Light_I_1x1.webp", style: "wood", tone: "light", wide: false },
  { path: "canvas/doors/small/Door_Wood_Red_D_1x1.webp", style: "wood", tone: "red", wide: false },
  { path: "canvas/doors/small/Door_Wood_Red_J_1x1.webp", style: "wood", tone: "red", wide: false },
  { path: "canvas/doors/small/Door_Wood_Red_K2_1x1.webp", style: "wood", tone: "red", wide: false },
  { path: "canvas/doors/small/Door_Wood_Walnut_F_1x1.webp", style: "wood", tone: "walnut", wide: false },
  { path: "canvas/doors/small/Door_Wood_Walnut_H_1x1.webp", style: "wood", tone: "walnut", wide: false },
  { path: "canvas/doors/small/Door_Wood_Walnut_R_1x1.webp", style: "wood", tone: "walnut", wide: false },
  { path: "canvas/doors/large/Door_Large_Wood_Ashen_C_2x1.webp", style: "wood", tone: "ashen", wide: true },
  { path: "canvas/doors/large/Door_Large_Wood_Dark_D_2x1.webp", style: "wood", tone: "dark", wide: true },
  { path: "canvas/doors/large/Door_Large_Wood_Light_F_2x1.webp", style: "wood", tone: "light", wide: true },
  { path: "canvas/doors/large/Portcullis_Metal_Rusty_A_2x1.webp", style: "portcullis", tone: "metal", wide: true },
  { path: "canvas/doors/large/Portcullis_Wood_Walnut_A_2x1.webp", style: "portcullis", tone: "wood", wide: true },
];

export interface PickDoorOptions {
  wide?: boolean;
  tone?: string;
  /** Stable number (a coordinate hash, an index) so a house gets varied but repeatable doors. */
  seed?: number;
}

/** Choose a texture of `style`, preferring the asked width and tone, falling back rather than failing. */
export function pickDoorTexture(style: DoorStyle, opts: PickDoorOptions = {}): DoorTexture {
  const ofStyle = DOOR_TEXTURES.filter((t) => t.style === style);
  const byWidth = ofStyle.filter((t) => t.wide === !!opts.wide);
  let pool = byWidth.length ? byWidth : ofStyle;
  const byTone = opts.tone ? pool.filter((t) => t.tone === opts.tone) : [];
  if (byTone.length) pool = byTone;
  const seed = Math.abs(Math.trunc(opts.seed ?? 0));
  return pool[seed % pool.length]!;
}

/** The animation that suits the look of the door: gates rise, stone slides, everything else swings. */
export function defaultDoorAnimation(style: DoorStyle): "swing" | "slide" | "ascend" {
  return style === "portcullis" ? "ascend" : style === "stone" ? "slide" : "swing";
}
