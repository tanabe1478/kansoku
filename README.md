# kansoku

> Architecture observability for agent-built software.

Kansokuは、リポジトリの構造、変更、品質に関する証拠を、人間が段階的に調査できる形へ変換するスタンドアローンツールです。特定のCoding Agent、IDE、CI、ハーネスには依存しません。

> [!NOTE]
> 現在は設計段階です。以下のCLIと成果物形式は、最初のvertical sliceを実装しながら検証します。

## なぜ作るのか

Coding Agentが生成できる変更量に対して、人間がすべてのdiffを同じ密度で読む方法は拡張しません。Kansokuはレビューを自動判定するのではなく、次の問いに答えることで、人間の注意を向ける場所を絞ります。

- 何が変わったか
- システムの構造や依存関係はどう変わったか
- 変更はどこまで波及し得るか
- どの判断に、どのソースや検査結果が根拠として紐づくか
- 人間はどこからコードへ掘り下げるべきか

## 設計原則

- **Diff first**: 現在の全体図だけでなく、変更前後の差を中心に扱う。
- **Evidence over scores**: 単一の品質スコアではなく、判断根拠とソース位置を示す。
- **Deterministic facts**: 構造抽出と明示的な規則の判定は、再現可能にする。
- **Human judgment**: 設計上のトレードオフをツールが断定しない。
- **Agent agnostic**: CLIとversioned artifactを境界にし、特定のAgentへ依存しない。
- **Local and read-only by default**: 既定ではリポジトリを変更せず、対象コードも実行しない。
- **Explicit unknowns**: 解析できないものを推測で補わず、不明または未対応として表す。

## 責務の境界

Kansokuが担当すること:

- リポジトリとGit差分から構造モデルを生成する
- 変更前後の構造差分と影響候補を表現する
- 外部ツールが生成したテスト・coverage・mutationなどの証拠を取り込む
- 図からファイルやシンボル、最終的にはソース位置まで掘り下げられるようにする
- 人間が選択した問題と根拠を、機械可読な形式で出力する

Kansokuが担当しないこと:

- Agentの起動、役割分担、修正ループの制御
- コードの自動修正
- テスト、型検査、セキュリティ検査の代替
- CRAPやmutation scoreなど、単一指標による品質の断定
- 最初からすべての言語やビルドシステムへ対応すること

Agent orchestrationはyorishiroなどのクライアントが担当します。

```text
Repository + external evidence
              │
              ▼
           Kansoku
  scan → compare → inspect
              │
              ▼
     versioned artifacts
              │
        ┌─────┴─────┐
        ▼           ▼
       Human    Agent harness / CI / IDE
```

## 最初のMVP

最初のvertical sliceでは、対象言語を一つに絞って次を一続きで実現します。

1. Git revisionとworking treeを入力として受け取る
2. モジュールと依存関係を抽出する
3. 変更されたノード・エッジを前後比較する
4. ローカルUIで構造からソース位置まで辿る
5. 選択した問題、対象path、根拠をJSONとして出力する

テスト結果やmutation testingなどの取り込みは、この基本ループを確認した後に追加します。

## CLI案

```bash
# mainと現在のworking treeを比較して解析成果物を生成する
kansoku scan . --base main --output .kansoku/runs/latest

# 生成済み成果物をローカルUIで開く
kansoku serve .kansoku/runs/latest

# 人間がUIで選択した内容を他のツールへ渡す
kansoku export .kansoku/runs/latest --selection current
```

`scan`は既定では対象リポジトリ内のプログラムや任意のproject commandを実行しません。将来コマンド実行を追加する場合も、明示的な設定と分離された実行境界を必要とします。

## 成果物案

```text
.kansoku/runs/latest/
├── manifest.json   # schema、入力revision、analyzerの識別情報
├── graph.json      # node、edge、source location
├── changes.json    # baseとtargetの構造差分
├── findings.json   # 規則違反や調査候補
├── evidence.json   # findingや構造判断の根拠
└── selection.json  # 人間が選択した対象と依頼内容
```

成果物ではプロジェクトルートからの相対pathを使用し、schema versionと解析器のversionを記録します。詳細は[`docs/architecture.md`](docs/architecture.md)を参照してください。

## yorishiroとの関係

Kansokuはyorishiroから独立して配布・実行できるようにします。yorishiroは最初の統合クライアントとして、Kansokuを起動し、`selection.json`と根拠をAgentへの修正依頼へ変換します。

```text
Kansoku:   事実を抽出し、人間が調査できるようにする
Yorishiro: 判断結果を作業契約へ変換し、Agentの実行を監督する
```
