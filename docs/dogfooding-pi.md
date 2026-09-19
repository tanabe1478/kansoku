# Dogfooding with pi

Kansokuの最初の対象として、TypeScript monorepoの[pi](https://github.com/earendil-works/pi)を解析します。この記録はベンチマークではなく、現在のモデルが人間の調査に役立つかを確認するための設計入力です。

## 実行方法

Kansoku repositoryから実行します。

```bash
node ./bin/kansoku.js scan ../pi \
  --base HEAD~1 \
  --output .kansoku/dogfood/pi

node ./bin/kansoku.js serve .kansoku/dogfood/pi
```

対象repositoryには書き込みません。生成物はKansoku側の`.kansoku/`へ保存します。

## 最初の観測結果

一つ前のcommitとclean working treeの比較で、次の結果を得ました。

| 項目 | 結果 |
|---|---:|
| TypeScript modules | 1,398 |
| Module reference edges | 5,048 |
| 検出したpackage境界 | 19 |
| 変更module | 1 |
| 追加・削除edge | 0 |
| 逆依存の影響候補 | 1,005 |
| 未解決の相対import | 49 |

変更moduleは`packages/ai/src/api/google-shared.ts`でした。直接参照している10 modulesとして、二つのprovider実装、public entry point、関連テストを抽出できました。変更されたmoduleと直接の参照元を見つける用途には、現在のモデルでも有効です。

## 見つかった問題

### 1. 推移的な逆依存closureは広すぎる

一つの変更から1,005 modulesが影響候補になりました。

```text
distance 0:   1
distance 1:  10
distance 2: 223
distance 3: 470
distance 4: 277
distance 5:  20
distance 6:   4
```

計算自体は逆依存graphとして正しくても、そのままでは人間の注意を絞れません。UIでは次を区別する必要があります。

- 直接参照と推移的参照
- production、test、example、documentation fixture
- runtime edgeとtype-only edge
- package entry pointを経由する参照

既定表示はdistance 1と変更package内を中心にし、推移的closureは要求されたときだけ展開する方がよいと考えます。

### 2. tracked TypeScript fileのすべてが実際のprogramではない

49件の未解決importは、内訳が次の通りでした。

- documentation内のコードsnapshot: 8
- JSON import: 40
- 配布用`.d.ts`から`dist`への参照: 1

実装の壊れた相対importは、この実行では見つかりませんでした。現在の「tracked TypeScript fileをすべて解析する」という範囲では、ドキュメント用コードや配布shimを本体と混同します。

次の解析ではpackageごとの`tsconfig`とinclude/excludeを尊重し、JSONなどのnon-code resource referenceを「未解決module」とは別分類にします。

### 3. `package.json`の存在だけではarchitecture boundaryにならない

examples、documentation fixture、install用packageもpackage nodeとして表示されます。これはrepository inventoryとしては事実ですが、workspaceの正式なpackage境界とは意味が異なります。

packageには少なくとも次の分類が必要です。

- root workspace member
- nested example
- fixture
- distribution helper
- unowned module

### 4. edgeに意味が不足している

現在のedgeはmodule referenceへ正規化しており、次を同じ関係として集約します。

- runtime import
- type-only import
- re-export
- dynamic import
- testからproductionへの参照

証拠にはsyntaxとtype-only情報を保持していますが、graphと影響計算でまだ利用していません。監督UIとして使うには、edge kindを表示と影響計算へ反映する必要があります。

## 次の優先順位

1. package単位の`tsconfig`から解析対象を決める
2. 影響候補をdistance、source category、edge kindで絞り込む
3. root workspace memberとfixture/example packageを区別する
4. graph上で追加・削除・変更をより強く表示する
5. 実際のレビューで選択した内容をyorishiroへ渡し、handoff contractを検証する

CRAP、coverage、mutation testingを追加する前に、まず構造graphのsignal-to-noise ratioを改善します。
