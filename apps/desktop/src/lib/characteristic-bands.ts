/**
 * Plain-language descriptions for CoC 7e characteristic values.
 *
 * New players see "STR 40" and have no idea what that means in real life.
 * These bands follow the 7th-edition rulebook's characteristic sidebars,
 * extended above 100 so published creature stat blocks stay readable in
 * combat: the table never laughs at a number, but everyone should feel it.
 */

export type CharacteristicKey =
  | "str"
  | "con"
  | "siz"
  | "dex"
  | "app"
  | "int"
  | "pow"
  | "edu"
  | "luck";

interface CharacteristicBand {
  /** Inclusive upper bound of the band; bands are evaluated in order. */
  readonly max: number;
  readonly text: string;
}

const BANDS: Record<CharacteristicKey, readonly CharacteristicBand[]> = {
  str: [
    { max: 0, text: "瘫软无力，无法站立" },
    { max: 14, text: "虚弱：病弱老人或幼童的力气" },
    { max: 39, text: "弱于常人，提重物就吃力" },
    { max: 59, text: "普通人的力气" },
    { max: 79, text: "强壮：常年劳作或健身的水平" },
    { max: 89, text: "非常强壮，健身房里的佼佼者" },
    { max: 98, text: "你认识的最强壮的人，职业运动员级" },
    { max: 99, text: "人类巅峰：奥运举重选手" },
    { max: 149, text: "超越人类：大猩猩般的膂力，徒手弯铁条" },
    { max: 199, text: "怪物级：撕碎门板、掀翻汽车" },
    { max: Infinity, text: "泰坦级：一击可碎砖墙" },
  ],
  con: [
    { max: 0, text: "生命垂危" },
    { max: 14, text: "病入膏肓，行动维艰" },
    { max: 39, text: "体弱多病" },
    { max: 59, text: "普通人的健康水平" },
    { max: 79, text: "强健：少生病，恢复快" },
    { max: 89, text: "铁打的身体" },
    { max: 98, text: "极耐病痛，你认识的最结实的人" },
    { max: 99, text: "人类巅峰的体魄" },
    { max: 149, text: "超越人类：毒素与疾病几乎无效" },
    { max: 199, text: "怪物级：常规伤害难以撼动" },
    { max: Infinity, text: "近乎不朽之躯" },
  ],
  siz: [
    { max: 0, text: "不足挂怀的微小之物" },
    { max: 14, text: "婴儿或小型犬的大小" },
    { max: 39, text: "儿童体格，或身高约 140cm 的娇小成人" },
    { max: 49, text: "身高约 150–160cm，体格偏小" },
    { max: 64, text: "身高约 160–175cm 的普通体格" },
    { max: 79, text: "身高约 175–185cm，或同等壮实体格" },
    { max: 89, text: "身高约 185–195cm 的魁梧巨汉" },
    { max: 99, text: "身高约 200cm 以上：巨人级，门框都嫌矮" },
    { max: 149, text: "超越人类：棕熊或骏马的体量" },
    { max: 199, text: "怪物级：犀牛乃至大象的体量" },
    { max: Infinity, text: "山岳般的庞然巨物" },
  ],
  dex: [
    { max: 0, text: "无法自主行动" },
    { max: 14, text: "行动迟缓，笨手笨脚" },
    { max: 39, text: "协调性差，常打翻东西" },
    { max: 59, text: "普通人的身手" },
    { max: 79, text: "灵活敏捷：业余运动员水平" },
    { max: 89, text: "身手矫健，受过体操或武术训练" },
    { max: 98, text: "顶尖运动员、杂技演员的身手" },
    { max: 99, text: "人类巅峰：奥运体操冠军" },
    { max: 149, text: "超越人类：快得肉眼难以捕捉" },
    { max: 199, text: "怪物级：移动如残影" },
    { max: Infinity, text: "瞬息之间，近乎瞬移" },
  ],
  app: [
    { max: 0, text: "令人不忍直视" },
    { max: 14, text: "面目可憎" },
    { max: 39, text: "其貌不扬" },
    { max: 59, text: "普通长相" },
    { max: 79, text: "有魅力，常被人多看一眼" },
    { max: 89, text: "出众：人群中的焦点" },
    { max: 98, text: "明星级的容貌" },
    { max: 99, text: "倾国倾城" },
    { max: Infinity, text: "非人的完美，摄人心魄的存在感" },
  ],
  int: [
    { max: 0, text: "没有思考能力" },
    { max: 14, text: "智力严重受损" },
    { max: 39, text: "反应迟钝，理解缓慢" },
    { max: 59, text: "普通人的头脑" },
    { max: 79, text: "聪明：一点就通" },
    { max: 89, text: "才智过人：学者、名校尖子" },
    { max: 98, text: "天才" },
    { max: 99, text: "世纪天才：爱因斯坦级" },
    { max: 149, text: "超越人类：思维快如计算机" },
    { max: Infinity, text: "非人智慧：凡人无法理解的思考维度" },
  ],
  pow: [
    { max: 0, text: "意志全无，如行尸走肉" },
    { max: 14, text: "意志薄弱，极易受摆布" },
    { max: 39, text: "缺乏主见，容易动摇" },
    { max: 59, text: "普通人的意志力" },
    { max: 79, text: "意志坚定" },
    { max: 89, text: "钢铁意志" },
    { max: 98, text: "罕见的精神力量，隐有通灵资质" },
    { max: 99, text: "人类精神力的极限" },
    { max: 149, text: "超越人类：精神力强得近乎魔法" },
    { max: 199, text: "强大存在：高阶施法者或异界生物的意志" },
    { max: Infinity, text: "神性意志" },
  ],
  edu: [
    { max: 0, text: "新生儿般一无所知" },
    { max: 14, text: "目不识丁" },
    { max: 39, text: "只有零散见闻，小学程度" },
    { max: 59, text: "初中到高中在读的知识量" },
    { max: 69, text: "高中毕业，受过良好通识教育" },
    { max: 79, text: "大学学历" },
    { max: 89, text: "硕士：对专业有深入研究" },
    { max: 95, text: "博士、教授" },
    { max: 99, text: "领域权威，著作等身" },
    { max: Infinity, text: "行走的图书馆，知晓凡人不该知晓之事" },
  ],
  luck: [
    { max: 0, text: "厄运化身" },
    { max: 14, text: "霉运缠身" },
    { max: 39, text: "时运不济" },
    { max: 59, text: "运气平平" },
    { max: 79, text: "运气不错" },
    { max: 89, text: "福星高照" },
    { max: 98, text: "天选之人" },
    { max: 99, text: "命运的宠儿" },
    { max: Infinity, text: "好运得不科学" },
  ],
};

export const CHARACTERISTIC_LABELS: Record<CharacteristicKey, string> = {
  str: "力量",
  con: "体质",
  siz: "体型",
  dex: "敏捷",
  app: "外貌",
  int: "智力",
  pow: "意志",
  edu: "教育",
  luck: "幸运",
};

/** Returns the plain-language band description for one characteristic value. */
export function describeCharacteristic(key: CharacteristicKey, value: number): string {
  if (!Number.isFinite(value) || value < 0) return "";
  const bands = BANDS[key];
  for (const band of bands) {
    if (value <= band.max) return band.text;
  }
  return bands[bands.length - 1]?.text ?? "";
}

/** Short form of the band (first clause only), for option rows and stat pills. */
export function shortCharacteristicBand(key: CharacteristicKey, value: number): string {
  const text = describeCharacteristic(key, value);
  const clause = text.split(/[：:，,]/u)[0] ?? "";
  return clause.trim();
}

const NAME_TO_KEY = new Map<string, CharacteristicKey>();
for (const [key, label] of Object.entries(CHARACTERISTIC_LABELS) as Array<[CharacteristicKey, string]>) {
  NAME_TO_KEY.set(label, key);
  NAME_TO_KEY.set(key, key);
  NAME_TO_KEY.set(key.toUpperCase(), key);
}
NAME_TO_KEY.set("运气", "luck");
NAME_TO_KEY.set("心灵", "pow");
NAME_TO_KEY.set("精神", "pow");

/**
 * Resolves a free-form stat name (Chinese label, "str", "STR", "力量 STR"…)
 * to a characteristic key. Skill names return undefined so mixed stat records
 * (module NPCs store characteristics and skills as loose name→value maps)
 * simply get no band text.
 */
export function resolveCharacteristicKey(name: string): CharacteristicKey | undefined {
  const trimmed = name.trim();
  const direct = NAME_TO_KEY.get(trimmed) ?? NAME_TO_KEY.get(trimmed.toLowerCase());
  if (direct) return direct;
  for (const part of trimmed.split(/\s+/u)) {
    const hit = NAME_TO_KEY.get(part) ?? NAME_TO_KEY.get(part.toLowerCase());
    if (hit) return hit;
  }
  return undefined;
}

/**
 * Short band suffix like "（弱于常人）" for a free-form stat name, or "" when
 * the name is not one of the nine characteristics.
 */
export function characteristicBandSuffix(name: string, value: number): string {
  const key = resolveCharacteristicKey(name);
  if (key === undefined) return "";
  const band = shortCharacteristicBand(key, value);
  return band === "" ? "" : `（${band}）`;
}
