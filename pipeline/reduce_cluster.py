"""차원 축소(PCA → UMAP 3D), 군집, 고차원 이웃.

지도(PCA·UMAP·KMeans)는 학습 대상(core)으로만 만들고, 나머지는 transform/predict로 투영한다.
"""
import warnings

import numpy as np
from sklearn.cluster import AgglomerativeClustering, KMeans
from sklearn.decomposition import PCA
from sklearn.metrics import adjusted_rand_score, silhouette_score
from sklearn.metrics.pairwise import cosine_similarity

PCA_DIM = 10
UMAP_NEIGHBORS = 10
UMAP_MIN_DIST = 0.12   # 낮을수록 가까운 사람끼리 더 촘촘하게 모인다
SEED = 42


def pca_reduce(X, dim=PCA_DIM):
    dim = min(dim, X.shape[0] - 1, X.shape[1])
    pca = PCA(n_components=dim, random_state=SEED)
    return pca.fit_transform(X), pca.explained_variance_ratio_


def umap_3d(Xp, seed=SEED, n_neighbors=UMAP_NEIGHBORS, min_dist=UMAP_MIN_DIST):
    import umap
    with warnings.catch_warnings():
        warnings.simplefilter("ignore")
        emb = umap.UMAP(n_components=3, n_neighbors=min(n_neighbors, len(Xp) - 1),
                        min_dist=min_dist, random_state=seed).fit_transform(Xp)
    emb = emb - emb.mean(axis=0)
    return emb / np.abs(emb).max()          # [-1, 1] 범위로 정규화


def kmeans(Xp, k, seed=SEED):
    return KMeans(n_clusters=k, n_init=20, random_state=seed).fit_predict(Xp)


def agglomerative(Xp, k):
    return AgglomerativeClustering(n_clusters=k, linkage="ward").fit_predict(Xp)


def cluster_scan(Xp, ks=range(4, 10), seeds=(0, 1, 2, 3, 4)):
    """k별 실루엣·시드 안정성(ARI)·KMeans-Agglo 일치도."""
    rows = []
    for k in ks:
        labels = [kmeans(Xp, k, s) for s in seeds]
        aris = [adjusted_rand_score(labels[0], l) for l in labels[1:]]
        agg = agglomerative(Xp, k)
        rows.append({
            "k": k,
            "sil_kmeans": silhouette_score(Xp, labels[0]),
            "sil_agglo": silhouette_score(Xp, agg),
            "seed_ari": float(np.mean(aris)),
            "km_vs_agglo_ari": adjusted_rand_score(labels[0], agg),
            "sizes": sorted(np.bincount(labels[0]).tolist(), reverse=True),
        })
    return rows


def neighbors(X, names, candidates=None, n_similar=3):
    """축소 전 고차원 공간의 코사인 유사도로 닮은꼴/정반대.
    candidates(불리언 배열)가 주어지면 그 플레이어들 중에서만 고른다 (관측 중인 사람은 후보에서 제외)."""
    sim = cosine_similarity(X)
    cand = np.ones(len(names), bool) if candidates is None else np.asarray(candidates, bool)
    out = {}
    for i, name in enumerate(names):
        order = [j for j in np.argsort(-sim[i]) if j != i and cand[j]]
        similar = [(names[j], float(sim[i, j])) for j in order[:n_similar]]
        far = order[-1]
        out[name] = {"similar": similar, "opposite": (names[far], float(sim[i, far]))}
    return out


class MapModel:
    """core로 PCA → UMAP 3D → KMeans를 학습하고, 전원을 같은 공간에 놓는다."""

    def __init__(self, k, seed=SEED, n_neighbors=UMAP_NEIGHBORS, min_dist=UMAP_MIN_DIST):
        self.k, self.seed = k, seed
        self.n_neighbors, self.min_dist = n_neighbors, min_dist

    def fit(self, X_core):
        import umap
        dim = min(PCA_DIM, X_core.shape[0] - 1, X_core.shape[1])
        self.pca = PCA(n_components=dim, random_state=self.seed).fit(X_core)
        Xp = self.pca.transform(X_core)
        self.km = KMeans(n_clusters=self.k, n_init=20, random_state=self.seed).fit(Xp)
        with warnings.catch_warnings():
            warnings.simplefilter("ignore")
            self.umap = umap.UMAP(n_components=3, n_neighbors=min(self.n_neighbors, len(Xp) - 1),
                                  min_dist=self.min_dist, random_state=self.seed).fit(Xp)
        emb = self.umap.embedding_
        self.center = emb.mean(axis=0)
        # 퍼짐이 큰 순서로 축을 돌려 (x, z)=가장 넓은 두 축, y=가장 좁은 축 → 원반처럼 눕히기 쉽게
        _, _, vt = np.linalg.svd(emb - self.center, full_matrices=False)
        self.axes = vt[[0, 2, 1]]
        aligned = (emb - self.center) @ self.axes.T
        self.scale = np.abs(aligned).max()
        return self

    def transform(self, X, core_mask):
        """core는 학습 때 좌표를 그대로, 나머지는 UMAP transform으로 투영."""
        core_mask = np.asarray(core_mask, bool)
        Xp = self.pca.transform(X)
        labels = self.km.predict(Xp)
        labels[core_mask] = self.km.labels_
        xyz = np.zeros((len(X), 3))
        xyz[core_mask] = self.umap.embedding_
        if (~core_mask).any():
            with warnings.catch_warnings():
                warnings.simplefilter("ignore")
                xyz[~core_mask] = self.umap.transform(Xp[~core_mask])
        return ((xyz - self.center) @ self.axes.T) / self.scale, labels, Xp
