# Scikit-learn verified seed v0.1

2026-07-15에 실제 open PR head를 `git merge-tree`와 repository context로 검증한 첫 회귀 시드입니다.

- `gold.jsonl`: 검증된 5개 원본 사례와 평가 포함/제외 사유
- `baseline-v0.2.0/`: causal gate 이전의 frozen baseline
- `baseline-v0.3.0/`: `causal-proof-v0.1` 적용 후 baseline과 오류 장부
- `baseline-v0.4.0/`: coordination subtype/action explainer 적용 후 baseline

5개 중 독립 관계 평가 대상은 3개입니다. `#34452 × #34393`은 stack이라 제외하고, `#34452 × #34464`는 descendant 대표 쌍 `#34393 × #34464`와 같은 충돌 계열이라 제외합니다. 기계적 merge conflict가 확인된 coordination 사례는 제품 관계 평가에는 포함하지만 silent semantic-conflict 지표에서는 제외합니다.

이 시드는 한 repository의 소수 사례이므로 일반 성능 점수가 아니라 회귀 방지용 닻입니다.
