const fs = require("fs");
const path = require("path");

const DEFAULT_RETRIEVAL_LIMIT = 8;
const ALWAYS_INCLUDE_KINDS = new Set(["preference", "constraint", "workflow"]);
const KIND_BASE_SCORE = Object.freeze({
  preference: 60,
  constraint: 70,
  workflow: 55,
  fact: 40,
});
const CONFIDENCE_SCORE = Object.freeze({
  high: 18,
  medium: 10,
  low: 4,
});

class EvolvingMemoryStore {
  constructor({
    filePath = "",
    retrievalLimit = DEFAULT_RETRIEVAL_LIMIT,
  } = {}) {
    this.filePath = String(filePath || "").trim();
    this.retrievalLimit = Number.isFinite(retrievalLimit) && retrievalLimit > 0
      ? Math.floor(retrievalLimit)
      : DEFAULT_RETRIEVAL_LIMIT;
  }

  isEnabled() {
    return !!this.filePath;
  }

  getUserProfile(userId) {
    const snapshot = this.readSnapshot();
    const user = snapshot.users[userId] || createEmptyUserState();
    return {
      profileSummary: normalizeValue(user.profileSummary),
      memories: Object.values(user.memories || {}).map((memory) => normalizeStoredMemory(memory)),
    };
  }

  getRelevantMemories({ userId, query, limit = this.retrievalLimit } = {}) {
    if (!this.isEnabled() || !userId) {
      return [];
    }

    const snapshot = this.readSnapshot();
    const user = snapshot.users[userId] || createEmptyUserState();
    const memories = Object.values(user.memories || {})
      .map((memory) => normalizeStoredMemory(memory))
      .filter((memory) => memory.key && memory.summary);

    if (!memories.length) {
      return [];
    }

    const normalizedQuery = normalizeValue(query).toLowerCase();
    const scored = memories
      .map((memory) => ({
        ...memory,
        score: scoreMemory(memory, normalizedQuery),
      }))
      .filter((memory) => memory.score > 0 || ALWAYS_INCLUDE_KINDS.has(memory.kind))
      .sort(compareScoredMemories);

    return scored.slice(0, Math.max(1, limit));
  }

  applyEvolution({ userId, evolution, observedAt = new Date().toISOString(), metadata = {} } = {}) {
    if (!this.isEnabled() || !userId) {
      return createApplyResult();
    }

    const normalizedEvolution = normalizeEvolutionPayload(evolution);
    if (!normalizedEvolution.upserts.length && !normalizedEvolution.deleteKeys.length && !normalizedEvolution.profileSummary) {
      return createApplyResult();
    }

    const snapshot = this.readSnapshot();
    const user = snapshot.users[userId] || createEmptyUserState();
    const memories = { ...(user.memories || {}) };
    const deleteKeys = new Set(normalizedEvolution.deleteKeys);

    normalizedEvolution.upserts.forEach((item) => {
      item.supersedes.forEach((key) => deleteKeys.add(key));
    });
    deleteKeys.forEach((key) => {
      delete memories[key];
    });

    const upsertedKeys = [];
    normalizedEvolution.upserts.forEach((item) => {
      const current = normalizeStoredMemory(memories[item.key]);
      memories[item.key] = {
        key: item.key,
        kind: item.kind,
        summary: item.summary,
        detail: item.detail || current.detail,
        confidence: item.confidence || current.confidence || "medium",
        evidence: item.evidence || current.evidence,
        relevanceHints: uniqueStrings([...(current.relevanceHints || []), ...item.relevanceHints]),
        source: normalizeValue(metadata.source) || current.source || "codex-1",
        createdAt: current.createdAt || observedAt,
        updatedAt: observedAt,
        lastObservedAt: observedAt,
        observationCount: Math.max(1, Number(current.observationCount || 0) + 1),
      };
      upsertedKeys.push(item.key);
    });

    snapshot.users[userId] = {
      profileSummary: normalizedEvolution.profileSummary || user.profileSummary || "",
      memories,
      updatedAt: observedAt,
    };
    this.writeSnapshot(snapshot);

    return {
      upsertedKeys,
      deletedKeys: [...deleteKeys],
      profileSummary: snapshot.users[userId].profileSummary || "",
      memoryCount: Object.keys(memories).length,
    };
  }

  readSnapshot() {
    if (!this.isEnabled()) {
      return createEmptySnapshot();
    }
    try {
      if (!fs.existsSync(this.filePath)) {
        return createEmptySnapshot();
      }
      const raw = JSON.parse(fs.readFileSync(this.filePath, "utf8"));
      return normalizeSnapshot(raw);
    } catch {
      return createEmptySnapshot();
    }
  }

  writeSnapshot(snapshot) {
    if (!this.isEnabled()) {
      return;
    }
    const normalized = normalizeSnapshot(snapshot);
    fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
    fs.writeFileSync(this.filePath, JSON.stringify(normalized, null, 2));
  }
}

function createEmptySnapshot() {
  return {
    version: 1,
    users: {},
  };
}

function createEmptyUserState() {
  return {
    profileSummary: "",
    memories: {},
    updatedAt: "",
  };
}

function createApplyResult() {
  return {
    upsertedKeys: [],
    deletedKeys: [],
    profileSummary: "",
    memoryCount: 0,
  };
}

function normalizeSnapshot(raw) {
  const input = raw && typeof raw === "object" ? raw : {};
  const users = input.users && typeof input.users === "object" ? input.users : {};
  const normalizedUsers = {};
  for (const [userId, userState] of Object.entries(users)) {
    const normalizedUserId = normalizeValue(userId);
    if (!normalizedUserId) {
      continue;
    }
    const current = userState && typeof userState === "object" ? userState : {};
    const memories = current.memories && typeof current.memories === "object" ? current.memories : {};
    const normalizedMemories = {};
    for (const [key, memory] of Object.entries(memories)) {
      const normalized = normalizeStoredMemory({ ...(memory || {}), key });
      if (!normalized.key || !normalized.summary) {
        continue;
      }
      normalizedMemories[normalized.key] = normalized;
    }
    normalizedUsers[normalizedUserId] = {
      profileSummary: normalizeValue(current.profileSummary),
      memories: normalizedMemories,
      updatedAt: normalizeValue(current.updatedAt),
    };
  }
  return {
    version: 1,
    users: normalizedUsers,
  };
}

function normalizeEvolutionPayload(raw) {
  const input = raw && typeof raw === "object" ? raw : {};
  const upserts = uniqueByKey(
    (Array.isArray(input.upserts) ? input.upserts : [])
      .map((item) => normalizeEvolutionUpsert(item))
      .filter((item) => item.key && item.kind && item.summary),
    (item) => item.key
  );
  const deleteKeys = uniqueStrings([
    ...(Array.isArray(input.deleteKeys) ? input.deleteKeys : []),
    ...(Array.isArray(input.delete_keys) ? input.delete_keys : []),
    ...(Array.isArray(input.forgetKeys) ? input.forgetKeys : []),
  ]);
  return {
    upserts,
    deleteKeys,
    profileSummary: normalizeValue(input.profileSummary || input.profile_summary),
  };
}

function normalizeEvolutionUpsert(raw) {
  const input = raw && typeof raw === "object" ? raw : {};
  const key = normalizeMemoryKey(input.key);
  const kind = normalizeMemoryKind(input.kind);
  return {
    key,
    kind,
    summary: normalizeValue(input.summary),
    detail: normalizeValue(input.detail),
    confidence: normalizeConfidence(input.confidence),
    evidence: normalizeValue(input.evidence),
    relevanceHints: uniqueStrings([
      ...(Array.isArray(input.relevanceHints) ? input.relevanceHints : []),
      ...(Array.isArray(input.relevance_hints) ? input.relevance_hints : []),
    ]),
    supersedes: uniqueStrings([
      ...(Array.isArray(input.supersedes) ? input.supersedes : []),
      ...(Array.isArray(input.replaceKeys) ? input.replaceKeys : []),
      ...(Array.isArray(input.replace_keys) ? input.replace_keys : []),
    ]).map((item) => normalizeMemoryKey(item)).filter(Boolean),
  };
}

function normalizeStoredMemory(raw) {
  const input = raw && typeof raw === "object" ? raw : {};
  return {
    key: normalizeMemoryKey(input.key),
    kind: normalizeMemoryKind(input.kind),
    summary: normalizeValue(input.summary),
    detail: normalizeValue(input.detail),
    confidence: normalizeConfidence(input.confidence),
    evidence: normalizeValue(input.evidence),
    relevanceHints: uniqueStrings(input.relevanceHints),
    source: normalizeValue(input.source),
    createdAt: normalizeValue(input.createdAt),
    updatedAt: normalizeValue(input.updatedAt),
    lastObservedAt: normalizeValue(input.lastObservedAt),
    observationCount: Math.max(0, Number(input.observationCount || 0)),
  };
}

function scoreMemory(memory, normalizedQuery) {
  let score = KIND_BASE_SCORE[memory.kind] || 25;
  score += CONFIDENCE_SCORE[memory.confidence] || 0;
  if (!normalizedQuery) {
    return score;
  }
  const queryTokens = tokenize(normalizedQuery);
  if (!queryTokens.length) {
    return score;
  }
  const haystack = buildMemorySearchText(memory);
  const overlapCount = queryTokens.filter((token) => haystack.includes(token)).length;
  if (overlapCount > 0) {
    score += overlapCount * 12;
  }
  if (ALWAYS_INCLUDE_KINDS.has(memory.kind)) {
    score += 6;
  }
  return score;
}

function compareScoredMemories(left, right) {
  if ((right.score || 0) !== (left.score || 0)) {
    return (right.score || 0) - (left.score || 0);
  }
  if ((right.updatedAt || "") !== (left.updatedAt || "")) {
    return String(right.updatedAt || "").localeCompare(String(left.updatedAt || ""));
  }
  return String(left.key || "").localeCompare(String(right.key || ""));
}

function buildMemorySearchText(memory) {
  return [
    memory.key,
    memory.kind,
    memory.summary,
    memory.detail,
    memory.evidence,
    ...(Array.isArray(memory.relevanceHints) ? memory.relevanceHints : []),
  ]
    .map((item) => normalizeValue(item).toLowerCase())
    .filter(Boolean)
    .join(" ");
}

function tokenize(value) {
  return uniqueStrings(
    normalizeValue(value)
      .toLowerCase()
      .split(/[^a-z0-9_\u4e00-\u9fff]+/i)
      .filter(Boolean)
  );
}

function normalizeMemoryKey(value) {
  const raw = normalizeValue(value).toLowerCase();
  if (!raw) {
    return "";
  }
  return raw
    .replace(/[^a-z0-9_]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 80);
}

function normalizeMemoryKind(value) {
  const raw = normalizeValue(value).toLowerCase();
  if (["preference", "fact", "constraint", "workflow"].includes(raw)) {
    return raw;
  }
  return "";
}

function normalizeConfidence(value) {
  const raw = normalizeValue(value).toLowerCase();
  if (["low", "medium", "high"].includes(raw)) {
    return raw;
  }
  return "medium";
}

function normalizeValue(value) {
  return typeof value === "string" ? value.trim() : "";
}

function uniqueStrings(items) {
  return [...new Set((Array.isArray(items) ? items : []).map((item) => normalizeValue(item)).filter(Boolean))];
}

function uniqueByKey(items, getKey) {
  const map = new Map();
  for (const item of Array.isArray(items) ? items : []) {
    const key = getKey(item);
    if (!key) {
      continue;
    }
    map.set(key, item);
  }
  return [...map.values()];
}

module.exports = {
  EvolvingMemoryStore,
  normalizeEvolutionPayload,
  normalizeStoredMemory,
};
