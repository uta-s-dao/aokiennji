console.error(
  "本格的な実モデル評価は未実施です（単発の接続確認はdocs/LIVE-SMOKE-20261116.jsonを参照）。OpenAI接続コードは実装済みですが、このコマンドは外部送信を実行しません。docs/INTAKE-INTEGRATION.mdに沿ってAPIキー・選択モデル・呼出し上限と費用上限を設定し、実評価を別途実施してください。",
);
process.exitCode = 2;
