# Architecture

この文書はKansokuの初期設計境界を定めます。実装技術や公開APIを固定するものではなく、vertical sliceの結果に応じて更新します。

## システム境界

Kansokuは、対象リポジトリから観測できる事実と外部の検査結果を、調査可能な中間表現へ変換します。Agentとの会話、修正の適用、承認フローは境界外です。

```text
                       ┌──────────────────────┐
Git repository ───────▶│                      │
Language source ──────▶│  Analysis pipeline   │──▶ Versioned artifacts
External evidence ────▶│                      │
                       └──────────┬───────────┘
                                  │
                                  ▼
                       Local inspection UI
                                  │
                                  ▼
                         Human selection
```

## 論理コンポーネント

```text
CLI / local UI
      │
      ▼
Application
├── scan
├── compare
├── query
└── export selection
      │
      ▼
Domain model
├── snapshot
├── structural graph
├── change
├── finding
├── evidence
└── selection
      │
      ▼
Ports
├── version control
├── language analyzer
├── evidence importer
└── artifact store
      │
      ▼
Adapters
├── Git
├── language-specific analyzers
├── JSON artifacts
└── local web UI
```

言語固有の解析器とUIをdomain modelから分離します。新しい言語や表示方法を追加しても、既存の成果物を読むクライアントが壊れないことを目指します。

## Domain model

### Snapshot

解析対象を再現するための識別情報です。

- repository rootを基準にした識別子
- base revision
- target revisionまたはworking tree fingerprint
- analyzer名、version、設定fingerprint
- artifact schema version

### Node

repository、package、module、type、functionなどの構造要素です。

最低限、次を保持します。

- snapshot間で可能な限り安定するID
- kind
- display name
- project-relative source location
- analyzer固有情報を隔離したattributes

### Edge

import、call、implementationなど、二つのnode間で観測された関係です。

すべてのedgeは、その関係を導いたsource locationまたは解析証拠へ遡れる必要があります。解析器が確定できない関係はconfidenceやunknownとして明示し、確定した事実と混在させません。

### Change

baseとtargetの比較結果です。

- nodeの追加、削除、変更、移動候補
- edgeの追加、削除、変更
- 変更により影響を受ける可能性があるnode

「影響を受ける可能性」と「実際に影響を受けたことが検証された」を区別します。

### Evidence

構造判断やfindingを裏づける情報です。

例:

- import declarationのsource range
- Git diff hunk
- test result
- coverage report
- mutation testing report
- 明示的なarchitecture rule

Evidenceは出所、生成器、対象snapshotを持ちます。外部ツールの結果をKansoku自身の判定として見せません。

### Finding

人間の注意を向けるための調査候補です。事実そのものとは分離します。

- ruleまたはproducer
- severityではなくcategoryと根拠を中心にした表示
- 関係するnode、edge、change
- evidenceへの参照
- 解決済み、抑制、受容などの状態は将来拡張

### Selection

人間が調査後に外部へ渡す判断です。

```json
{
  "schemaVersion": "0.1",
  "findingId": "finding:new-boundary-edge:domain-to-adapter",
  "targets": [
    {
      "path": "src/domain/order.ts",
      "line": 12
    }
  ],
  "evidenceIds": [
    "evidence:import:src/domain/order.ts:12"
  ],
  "requestedOutcome": "Remove the domain-to-adapter dependency."
}
```

SelectionはAgent用promptそのものではありません。yorishiro、他のAgent harness、IDEなどが、それぞれの作業契約へ変換します。

## Artifact contract

初期成果物はJSONとし、次を必須にします。

- `schemaVersion`
- project-relative path
- stable IDと参照整合性
- base/targetのfingerprint
- analyzerの名前とversion
- sourceまたはevidenceへの追跡可能性

時刻やローカルの絶対pathなど、同じ入力からの再現性を損なう情報はcore artifactから分離します。現在はローカルUIがsourceを読むためのrepository rootと生成時刻だけを`local.json`へ保存しています。

schema変更は明示的にversioningします。UIは解析プロセスのメモリ状態ではなく、保存されたartifactだけから同じ表示を再構築できるようにします。

## 安全性

- 解析は既定でread-onlyとする。
- 出力は明示されたdirectoryの下だけへ書き込む。
- 対象repositoryの任意コードを既定で実行しない。
- symlinkやrepository root外へのpath traversalを拒否する。
- 解析不能な入力で、もっともらしい構造を生成しない。
- source contentsを外部サービスへ送信しない。将来連携する場合はopt-inとする。

## MVPの実装順序

### 0. Vertical spike

- 最初の対象言語を決める
- module/import抽出の方法を比較する
- 小さなfixtureからgraph artifactを生成する
- 生成したartifactだけを使って最小UIを表示する

この段階でruntime、配布形式、UI stackを決定します。

### 1. Scan

- revisionとworking treeを安全に読み取る
- node、edge、source locationを生成する
- schema validationとdeterminism testを追加する

### 2. Compare and inspect

- stable IDを使ってbase/targetを比較する
- node/edgeの差分を表示する
- graphからsource locationへ掘り下げる

### 3. Selection export

- UI上で対象と根拠を選択する
- `selection.json`を出力する
- 外部クライアントが入力検証できるschemaを提供する

### 4. Evidence adapters

基本ループを検証した後、test、coverage、mutation、architecture policyなどを個別adapterとして追加します。

## Vertical sliceで決定したこと

- Node.js 22以降で動作するスタンドアローンCLIとする
- 最初の解析対象をTypeScriptとする
- 正規表現ではなくTypeScript compiler APIからmodule referenceを抽出する
- UIは保存済みJSON artifactを読むlocalhost限定のWeb UIとする
- 依存追加を抑えるため、最初のUIはframeworkを使用しない

## 未決定事項

以下はdogfoodingの結果を見て決定します。

- npm packageやsingle executableなどの配布形式
- compiler optionをpackage単位で解決する方法
- editorへsource jumpするためのprotocol
- 大規模repository向けの保存・incremental analysis方式
- test、coverage、mutation、runtime traceのevidence adapter形式
