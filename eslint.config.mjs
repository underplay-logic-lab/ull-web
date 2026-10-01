import { defineConfig, globalIgnores } from "eslint/config";
import nextVitals from "eslint-config-next/core-web-vitals";
import nextTs from "eslint-config-next/typescript";

const eslintConfig = defineConfig([
  ...nextVitals,
  ...nextTs,
  // Studio の画像・動画は切り抜かない（2026-09-27、ホスト指摘「サムネが見切れている」が 5 タブで再発）。
  // ユーザーの素材・生成物は全体が見えないと選べない。object-contain（＋背景色）を使う。
  // 比較スライダーのように意図して重ねる箇所だけ、理由を書いて eslint-disable する。
  {
    files: ["src/components/studio/**/*.tsx"],
    rules: {
      "no-restricted-syntax": [
        "error",
        {
          selector: "Literal[value=/object-cover/], TemplateElement[value.raw=/object-cover/]",
          message: "Studio の画像・動画は object-contain を使う（切り抜くと素材・生成物が見切れる）。意図的なら理由を書いて disable。",
        },
      ],
    },
  },
  // Override default ignores of eslint-config-next.
  globalIgnores([
    // Default ignores of eslint-config-next:
    ".next/**",
    "out/**",
    "build/**",
    "next-env.d.ts",
    // 紹介動画（Remotion）は別プロジェクト。依存も設定も promo/ の中で完結させる。
    "promo/**",
  ]),
]);

export default eslintConfig;
