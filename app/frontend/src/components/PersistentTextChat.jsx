import {
  MessageSquarePlus,
  Pin,
  RefreshCw,
  Save,
  Search,
  Send,
  Trash2,
  ThumbsDown,
  ThumbsUp,
  CheckCircle2,
  RotateCcw,
} from "lucide-react";
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";

function formatDate(value) {
  if (!value) {
    return "";
  }

  return new Intl.DateTimeFormat(
    "th-TH",
    {
      dateStyle: "short",
      timeStyle: "short",
    },
  ).format(
    new Date(value),
  );
}

export default function PersistentTextChat() {
  const [conversations, setConversations] =
    useState([]);

  const [
    activeConversationId,
    setActiveConversationId,
  ] = useState("");

  const [draft, setDraft] =
    useState("");

  const [search, setSearch] =
    useState("");

  const [loading, setLoading] =
    useState(true);

  const [saving, setSaving] =
    useState(false);

  // LUKE_AI_TEXT_GENERATION_STREAMING_UI_V1
  const [
    generating,
    setGenerating,
  ] = useState(false);

  const [
    streamingResponse,
    setStreamingResponse,
  ] = useState("");

  // LUKE_AI_MULTI_MODEL_GENERATION_UI_V1
  const [
    availableModels,
    setAvailableModels,
  ] = useState([]);

  const [
    selectedModelIds,
    setSelectedModelIds,
  ] = useState([]);

  const [
    multiModelEnabled,
    setMultiModelEnabled,
  ] = useState(false);

  const [
    multiGenerating,
    setMultiGenerating,
  ] = useState(false);

  const [
    multiResponses,
    setMultiResponses,
  ] = useState({});

  const [
    multiEvaluation,
    setMultiEvaluation,
  ] = useState(null);

  // LUKE_AI_JUDGE_SYNTHESIS_UI_V1
  const [
    judgeGenerating,
    setJudgeGenerating,
  ] = useState(false);

  const [
    judgeResponse,
    setJudgeResponse,
  ] = useState("");

  const [
    judgeFallback,
    setJudgeFallback,
  ] = useState(false);

  const generationAbortRef =
    useRef(null);

  // LUKE_AI_TEXT_CHAT_MEMORY_UI_V1
  const [
    memoryStatus,
    setMemoryStatus,
  ] = useState(null);

  const [
    optimizingMemory,
    setOptimizingMemory,
  ] = useState(false);

  // LUKE_AI_TEXT_RUNTIME_SESSION_UI_V1
  const [
    runtimeSession,
    setRuntimeSession,
  ] = useState(null);

  const [
    refreshingRuntime,
    setRefreshingRuntime,
  ] = useState(false);

  const [error, setError] =
    useState("");

  // LUKE_AI_TEXT_MODEL_FEEDBACK_UI_V1
  const [
    feedbackBusyId,
    setFeedbackBusyId,
  ] = useState("");

  const mountedRef = useRef(true);

  const requestJson = useCallback(
    async (
      url,
      options = {},
    ) => {
      const response = await fetch(
        url,
        {
          ...options,
          headers: {
            "content-type":
              "application/json",
            ...(options.headers || {}),
          },
        },
      );

      const text =
        await response.text();

      let data = null;

      try {
        data =
          text
            ? JSON.parse(text)
            : null;
      } catch {
        throw new Error(
          "Backend returned invalid JSON.",
        );
      }

      if (!response.ok) {
        throw new Error(
          data?.error ||
          `HTTP ${response.status}`,
        );
      }

      return data;
    },
    [],
  );

  const refresh = useCallback(
    async () => {
      try {
        const data =
          await requestJson(
            "/api/text-chat/conversations",
          );

        if (!mountedRef.current) {
          return;
        }

        const nextConversations =
          data.conversations || [];

        setConversations(
          nextConversations,
        );

        setActiveConversationId(
          (
            currentId =>
              nextConversations.some(
                (conversation) =>
                  conversation.id ===
                  currentId,
              )
                ? currentId
                : (
                    data.lastOpenedConversationId ||
                    nextConversations[0]?.id ||
                    ""
                  )
          )(activeConversationId),
        );

        setError("");
      } catch (refreshError) {
        if (mountedRef.current) {
          setError(
            refreshError instanceof Error
              ? refreshError.message
              : String(refreshError),
          );
        }
      } finally {
        if (mountedRef.current) {
          setLoading(false);
        }
      }
    },
    [
      activeConversationId,
      requestJson,
    ],
  );

  useEffect(() => {
    mountedRef.current = true;
    refresh();

    return () => {
      mountedRef.current = false;
    };
  }, [refresh]);

  useEffect(() => {
    let cancelled = false;

    const loadModels = async () => {
      try {
        const data =
          await requestJson(
            "/api/text-runtime/models/available",
          );

        if (cancelled) {
          return;
        }

        const models =
          data.models || [];

        setAvailableModels(models);

        setSelectedModelIds(
          (current) => {
            const existing =
              current.filter(
                (modelId) =>
                  models.some(
                    (model) =>
                      model.modelId ===
                      modelId,
                  ),
              );

            if (existing.length) {
              return existing.slice(
                0,
                data.maximumSelection || 3,
              );
            }

            return models
              .slice(0, 1)
              .map(
                (model) =>
                  model.modelId,
              );
          },
        );
      } catch {
        if (!cancelled) {
          setAvailableModels([]);
        }
      }
    };

    loadModels();

    return () => {
      cancelled = true;
    };
  }, [requestJson]);

  const activeConversation = useMemo(
    () =>
      conversations.find(
        (conversation) =>
          conversation.id ===
          activeConversationId,
      ) || null,
    [
      conversations,
      activeConversationId,
    ],
  );

  const refreshMemoryStatus =
    useCallback(
      async (
        conversationId,
      ) => {
        if (!conversationId) {
          setMemoryStatus(null);
          return;
        }

        try {
          const data =
            await requestJson(
              "/api/text-chat/memory/status",
              {
                method: "POST",
                body: JSON.stringify({
                  conversationId,
                }),
              },
            );

          setMemoryStatus(data);
        } catch {
          setMemoryStatus(null);
        }
      },
      [requestJson],
    );

  const refreshRuntimeSession =
    useCallback(
      async ({
        automatic = false,
      } = {}) => {
        if (!activeConversationId) {
          return;
        }

        setRefreshingRuntime(true);

        try {
          const data =
            await requestJson(
              "/api/text-runtime/session/refresh",
              {
                method: "POST",
                body: JSON.stringify({
                  conversationId:
                    activeConversationId,
                  forceMemoryRefresh:
                    true,
                  reason:
                    automatic
                      ? "automatic-context-or-ram-threshold"
                      : "manual-user-request",
                }),
              },
            );

          setRuntimeSession(data);

          await refreshMemoryStatus(
            activeConversationId,
          );

          await refresh();
        } catch (runtimeError) {
          setError(
            runtimeError instanceof Error
              ? runtimeError.message
              : String(runtimeError),
          );
        } finally {
          setRefreshingRuntime(false);
        }
      },
      [
        activeConversationId,
        refresh,
        refreshMemoryStatus,
        requestJson,
      ],
    );

  useEffect(() => {
    if (
      !activeConversationId ||
      !memoryStatus
    ) {
      return;
    }

    const requiresRefresh =
      memoryStatus.context?.action ===
        "refresh" ||
      [
        "refresh",
        "emergency-refresh",
      ].includes(
        memoryStatus.ram?.action,
      );

    const alreadyRefreshing =
      refreshingRuntime ||
      [
        "preparing",
        "unloading",
        "loading",
        "verifying",
      ].includes(
        runtimeSession?.status,
      );

    if (
      requiresRefresh &&
      !alreadyRefreshing
    ) {
      refreshRuntimeSession({
        automatic: true,
      });
    }
  }, [
    activeConversationId,
    memoryStatus,
    refreshingRuntime,
    refreshRuntimeSession,
    runtimeSession?.status,
  ]);

  const optimizeMemory =
    useCallback(
      async () => {
        if (!activeConversationId) {
          return;
        }

        setOptimizingMemory(true);

        try {
          const data =
            await requestJson(
              "/api/text-chat/memory/optimize",
              {
                method: "POST",
                body: JSON.stringify({
                  conversationId:
                    activeConversationId,
                  force: true,
                  reason:
                    "manual-user-request",
                }),
              },
            );

          setMemoryStatus({
            ok: true,
            conversationId:
              activeConversationId,
            context:
              data.context,
            ram:
              data.ram,
            memory: {
              hasSummary:
                Boolean(
                  data.conversation
                    ?.memory?.summary,
                ),
              factCount:
                data.conversation
                  ?.memory?.facts
                  ?.length || 0,
              decisionCount:
                data.conversation
                  ?.memory?.decisions
                  ?.length || 0,
              taskCount:
                data.conversation
                  ?.memory?.tasks
                  ?.length || 0,
              snapshotCount:
                data.conversation
                  ?.memory?.snapshots
                  ?.length || 0,
              lastCompactedAt:
                data.conversation
                  ?.memory
                  ?.lastCompactedAt ||
                null,
            },
            session: {
              id:
                data.session?.id ||
                data.conversation
                  ?.session?.id ||
                null,
              refreshCount:
                data.conversation
                  ?.session
                  ?.refreshCount || 0,
              refreshedAt:
                data.conversation
                  ?.session
                  ?.refreshedAt || null,
              refreshReason:
                data.conversation
                  ?.session
                  ?.refreshReason || null,
            },
          });

          await refresh();
        } catch (optimizeError) {
          setError(
            optimizeError instanceof Error
              ? optimizeError.message
              : String(optimizeError),
          );
        } finally {
          setOptimizingMemory(false);
        }
      },
      [
        activeConversationId,
        refresh,
        requestJson,
      ],
    );

  useEffect(() => {
    refreshMemoryStatus(
      activeConversationId,
    );

    const interval =
      window.setInterval(
        () => {
          refreshMemoryStatus(
            activeConversationId,
          );
        },
        5000,
      );

    return () => {
      window.clearInterval(interval);
    };
  }, [
    activeConversationId,
    refreshMemoryStatus,
  ]);

  const filteredConversations = useMemo(
    () => {
      const query =
        search.trim().toLowerCase();

      return [...conversations]
        .filter(
          (conversation) =>
            !query ||
            conversation.title
              .toLowerCase()
              .includes(query) ||
            conversation.messages?.some(
              (message) =>
                message.content
                  .toLowerCase()
                  .includes(query),
            ),
        )
        .sort(
          (left, right) =>
            Number(right.pinned) -
              Number(left.pinned) ||
            new Date(
              right.updatedAt,
            ).getTime() -
              new Date(
                left.updatedAt,
              ).getTime(),
        );
    },
    [
      conversations,
      search,
    ],
  );

  const createConversation =
    useCallback(
      async () => {
        setSaving(true);
        setError("");

        try {
          const data =
            await requestJson(
              "/api/text-chat/conversations",
              {
                method: "POST",
                body: JSON.stringify({
                  title:
                    "บทสนทนาใหม่",
                }),
              },
            );

          setConversations(
            (current) => [
              data.conversation,
              ...current,
            ],
          );

          setActiveConversationId(
            data.conversation.id,
          );

          setDraft("");
        } catch (createError) {
          setError(
            createError instanceof Error
              ? createError.message
              : String(createError),
          );
        } finally {
          setSaving(false);
        }
      },
      [requestJson],
    );

  const generateJudgeSynthesis =
    useCallback(
      async () => {
        if (!activeConversationId) {
          return;
        }

        setJudgeGenerating(true);
        setJudgeResponse("");
        setJudgeFallback(false);
        setError("");

        const controller =
          new AbortController();

        generationAbortRef.current =
          controller;

        try {
          const response = await fetch(
            "/api/text-runtime/judge-synthesis",
            {
              method: "POST",
              headers: {
                "content-type":
                  "application/json",
              },
              body: JSON.stringify({
                conversationId:
                  activeConversationId,
              }),
              signal:
                controller.signal,
            },
          );

          if (!response.ok) {
            throw new Error(
              await response.text() ||
              `HTTP ${response.status}`,
            );
          }

          if (!response.body) {
            throw new Error(
              "AI Judge stream is unavailable.",
            );
          }

          const reader =
            response.body.getReader();

          const decoder =
            new TextDecoder();

          let buffer = "";
          let accumulated = "";

          while (true) {
            const result =
              await reader.read();

            if (result.done) {
              break;
            }

            buffer += decoder.decode(
              result.value,
              {
                stream: true,
              },
            );

            const frames =
              buffer.split("\n\n");

            buffer =
              frames.pop() || "";

            for (const frame of frames) {
              const lines =
                frame.split(/\r?\n/);

              let eventName =
                "message";

              let dataText = "";

              for (const line of lines) {
                if (
                  line.startsWith(
                    "event:",
                  )
                ) {
                  eventName =
                    line
                      .slice(6)
                      .trim();
                }

                if (
                  line.startsWith(
                    "data:",
                  )
                ) {
                  dataText +=
                    line
                      .slice(5)
                      .trim();
                }
              }

              if (!dataText) {
                continue;
              }

              let payload = null;

              try {
                payload =
                  JSON.parse(dataText);
              } catch {
                continue;
              }

              if (
                eventName ===
                  "judge-delta" &&
                typeof payload.content ===
                  "string"
              ) {
                accumulated +=
                  payload.content;

                setJudgeResponse(
                  accumulated,
                );
              }

              if (
                eventName ===
                "judge-fallback"
              ) {
                setJudgeFallback(true);

                setJudgeResponse(
                  payload.content || "",
                );
              }

              if (
                eventName === "error"
              ) {
                throw new Error(
                  payload.error ||
                  "AI Judge synthesis failed.",
                );
              }
            }
          }

          await refresh();

          await refreshMemoryStatus(
            activeConversationId,
          );
        } catch (judgeError) {
          if (
            judgeError?.name !==
            "AbortError"
          ) {
            setError(
              judgeError instanceof Error
                ? judgeError.message
                : String(judgeError),
            );
          }
        } finally {
          generationAbortRef.current =
            null;

          setJudgeGenerating(false);
        }
      },
      [
        activeConversationId,
        refresh,
        refreshMemoryStatus,
      ],
    );

  const stopJudgeSynthesis =
    useCallback(
      async () => {
        if (!activeConversationId) {
          return;
        }

        try {
          await requestJson(
            "/api/text-runtime/judge-synthesis/stop",
            {
              method: "POST",
              body: JSON.stringify({
                conversationId:
                  activeConversationId,
              }),
            },
          );
        } catch {}

        generationAbortRef.current
          ?.abort();

        setJudgeGenerating(false);
      },
      [
        activeConversationId,
        requestJson,
      ],
    );

  const generateMultiModelResponses =
    useCallback(
      async (
        conversationId,
      ) => {
        const modelIds =
          selectedModelIds
            .slice(0, 3);

        if (!modelIds.length) {
          setError(
            "กรุณาเลือกโมเดลอย่างน้อย 1 โมเดล",
          );
          return;
        }

        setMultiGenerating(true);
        setMultiResponses({});
        setMultiEvaluation(null);
        setError("");

        const controller =
          new AbortController();

        generationAbortRef.current =
          controller;

        try {
          const response = await fetch(
            "/api/text-runtime/multi-generate-stream",
            {
              method: "POST",
              headers: {
                "content-type":
                  "application/json",
              },
              body: JSON.stringify({
                conversationId,
                modelIds,
              }),
              signal:
                controller.signal,
            },
          );

          if (!response.ok) {
            const message =
              await response.text();

            throw new Error(
              message ||
              `HTTP ${response.status}`,
            );
          }

          if (!response.body) {
            throw new Error(
              "Multi-model stream is unavailable.",
            );
          }

          const reader =
            response.body.getReader();

          const decoder =
            new TextDecoder();

          let buffer = "";

          while (true) {
            const result =
              await reader.read();

            if (result.done) {
              break;
            }

            buffer += decoder.decode(
              result.value,
              {
                stream: true,
              },
            );

            const frames =
              buffer.split("\n\n");

            buffer =
              frames.pop() || "";

            for (const frame of frames) {
              const lines =
                frame.split(/\r?\n/);

              let eventName =
                "message";

              let dataText = "";

              for (const line of lines) {
                if (
                  line.startsWith(
                    "event:",
                  )
                ) {
                  eventName =
                    line
                      .slice(6)
                      .trim();
                }

                if (
                  line.startsWith(
                    "data:",
                  )
                ) {
                  dataText +=
                    line
                      .slice(5)
                      .trim();
                }
              }

              if (!dataText) {
                continue;
              }

              let payload = null;

              try {
                payload =
                  JSON.parse(dataText);
              } catch {
                continue;
              }

              if (
                eventName ===
                  "model-delta" &&
                payload.modelId &&
                typeof payload.content ===
                  "string"
              ) {
                setMultiResponses(
                  (current) => ({
                    ...current,
                    [payload.modelId]:
                      (
                        current[
                          payload.modelId
                        ] || ""
                      ) +
                      payload.content,
                  }),
                );
              }

              if (
                eventName ===
                "multi-complete"
              ) {
                setMultiEvaluation(
                  payload,
                );
              }

              if (
                eventName === "error"
              ) {
                throw new Error(
                  payload.error ||
                  "Multi-model generation failed.",
                );
              }
            }
          }

          await refresh();

          await refreshMemoryStatus(
            conversationId,
          );
        } catch (generationError) {
          if (
            generationError?.name !==
            "AbortError"
          ) {
            setError(
              generationError instanceof Error
                ? generationError.message
                : String(
                    generationError,
                  ),
            );
          }
        } finally {
          generationAbortRef.current =
            null;

          setMultiGenerating(false);
        }
      },
      [
        refresh,
        refreshMemoryStatus,
        selectedModelIds,
      ],
    );

  const stopMultiModelGeneration =
    useCallback(
      async () => {
        if (!activeConversationId) {
          return;
        }

        try {
          await requestJson(
            "/api/text-runtime/multi-generation/stop",
            {
              method: "POST",
              body: JSON.stringify({
                conversationId:
                  activeConversationId,
              }),
            },
          );
        } catch {}

        generationAbortRef.current
          ?.abort();

        setMultiGenerating(false);
      },
      [
        activeConversationId,
        requestJson,
      ],
    );

  const generateAssistantResponse =
    useCallback(
      async (
        conversationId,
      ) => {
        setGenerating(true);
        setStreamingResponse("");
        setError("");

        const controller =
          new AbortController();

        generationAbortRef.current =
          controller;

        try {
          const response = await fetch(
            "/api/text-runtime/generate-stream",
            {
              method: "POST",
              headers: {
                "content-type":
                  "application/json",
              },
              body: JSON.stringify({
                conversationId,
              }),
              signal:
                controller.signal,
            },
          );

          if (!response.ok) {
            const errorText =
              await response.text();

            let message =
              errorText ||
              `HTTP ${response.status}`;

            try {
              const parsed =
                JSON.parse(errorText);

              message =
                parsed.error ||
                message;
            } catch {}

            throw new Error(message);
          }

          if (!response.body) {
            throw new Error(
              "Streaming response is unavailable.",
            );
          }

          const reader =
            response.body.getReader();

          const decoder =
            new TextDecoder();

          let buffer = "";
          let accumulated = "";

          while (true) {
            const result =
              await reader.read();

            if (result.done) {
              break;
            }

            buffer += decoder.decode(
              result.value,
              {
                stream: true,
              },
            );

            const frames =
              buffer.split("\\n\\n");

            buffer =
              frames.pop() || "";

            for (const frame of frames) {
              const lines =
                frame.split(/\\r?\\n/);

              let eventName =
                "message";

              let dataText = "";

              for (const line of lines) {
                if (
                  line.startsWith(
                    "event:",
                  )
                ) {
                  eventName =
                    line
                      .slice(6)
                      .trim();
                }

                if (
                  line.startsWith(
                    "data:",
                  )
                ) {
                  dataText +=
                    line
                      .slice(5)
                      .trim();
                }
              }

              if (!dataText) {
                continue;
              }

              let payload = null;

              try {
                payload =
                  JSON.parse(dataText);
              } catch {
                continue;
              }

              if (
                eventName === "delta" &&
                typeof payload.content ===
                  "string"
              ) {
                accumulated +=
                  payload.content;

                setStreamingResponse(
                  accumulated,
                );
              }

              if (
                eventName === "error"
              ) {
                throw new Error(
                  payload.error ||
                  "Text generation failed.",
                );
              }
            }
          }

          setStreamingResponse("");

          await refresh();

          await refreshMemoryStatus(
            conversationId,
          );
        } catch (generationError) {
          if (
            generationError?.name !==
            "AbortError"
          ) {
            setError(
              generationError instanceof Error
                ? generationError.message
                : String(
                    generationError,
                  ),
            );
          }
        } finally {
          generationAbortRef.current =
            null;

          setGenerating(false);
        }
      },
      [
        refresh,
        refreshMemoryStatus,
      ],
    );

  const stopGeneration =
    useCallback(
      async () => {
        if (!activeConversationId) {
          return;
        }

        try {
          await requestJson(
            "/api/text-runtime/generation/stop",
            {
              method: "POST",
              body: JSON.stringify({
                conversationId:
                  activeConversationId,
              }),
            },
          );
        } catch {}

        generationAbortRef.current
          ?.abort();

        setGenerating(false);
      },
      [
        activeConversationId,
        requestJson,
      ],
    );

  const sendMessage =
    useCallback(
      async () => {
        const content =
          draft.trim();

        if (
          !content ||
          generating
        ) {
          return;
        }

        setSaving(true);
        setError("");

        try {
          let conversationId =
            activeConversationId;

          if (!conversationId) {
            const created =
              await requestJson(
                "/api/text-chat/conversations",
                {
                  method: "POST",
                  body: JSON.stringify({
                    title:
                      "บทสนทนาใหม่",
                  }),
                },
              );

            conversationId =
              created.conversation.id;
          }

          const data =
            await requestJson(
              `/api/text-chat/conversations/${encodeURIComponent(
                conversationId,
              )}/messages`,
              {
                method: "POST",
                body: JSON.stringify({
                  role: "user",
                  content,
                }),
              },
            );

          setConversations(
            (current) => {
              const remaining =
                current.filter(
                  (conversation) =>
                    conversation.id !==
                    conversationId,
                );

              return [
                data.conversation,
                ...remaining,
              ];
            },
          );

          setActiveConversationId(
            conversationId,
          );

          setDraft("");

          setSaving(false);

          if (
            multiModelEnabled &&
            selectedModelIds.length > 0
          ) {
            await generateMultiModelResponses(
              conversationId,
            );
          } else {
            await generateAssistantResponse(
              conversationId,
            );
          }
        } catch (sendError) {
          setError(
            sendError instanceof Error
              ? sendError.message
              : String(sendError),
          );

          setSaving(false);
        }
      },
      [
        activeConversationId,
        draft,
        generateAssistantResponse,
        generateMultiModelResponses,
        generating,
        multiModelEnabled,
        selectedModelIds,
        requestJson,
      ],
    );

  const submitMessageFeedback =
    useCallback(
      async (
        message,
        feedbackType,
      ) => {
        if (
          !activeConversationId ||
          !message?.id
        ) {
          return;
        }

        setFeedbackBusyId(
          message.id,
        );

        try {
          const data =
            await requestJson(
              "/api/text-chat/feedback",
              {
                method: "POST",
                body: JSON.stringify({
                  conversationId:
                    activeConversationId,
                  messageId:
                    message.id,
                  feedbackType,
                }),
              },
            );

          setConversations(
            (current) =>
              current.map(
                (conversation) =>
                  conversation.id ===
                  activeConversationId
                    ? {
                        ...conversation,
                        messages:
                          conversation.messages.map(
                            (candidate) =>
                              candidate.id ===
                              data.message.id
                                ? data.message
                                : (
                                    feedbackType ===
                                      "preferred" &&
                                    candidate.role ===
                                      "assistant"
                                  )
                                  ? {
                                      ...candidate,
                                      metadata: {
                                        ...(candidate.metadata || {}),
                                        userPreferred:
                                          candidate.id ===
                                          data.message.id,
                                      },
                                    }
                                  : candidate,
                          ),
                      }
                    : conversation,
              ),
          );

          setError("");
        } catch (feedbackError) {
          setError(
            feedbackError instanceof Error
              ? feedbackError.message
              : String(feedbackError),
          );
        } finally {
          setFeedbackBusyId("");
        }
      },
      [
        activeConversationId,
        requestJson,
      ],
    );

  const regenerateMessage =
    useCallback(
      async (message) => {
        if (
          !activeConversationId ||
          !message
        ) {
          return;
        }

        await submitMessageFeedback(
          message,
          "regenerate",
        );

        if (message.modelId) {
          setSelectedModelIds([
            message.modelId,
          ]);

          setMultiModelEnabled(false);
        }

        await generateAssistantResponse(
          activeConversationId,
        );
      },
      [
        activeConversationId,
        generateAssistantResponse,
        submitMessageFeedback,
      ],
    );

  const togglePin = useCallback(
    async (conversation) => {
      try {
        const data =
          await requestJson(
            `/api/text-chat/conversations/${encodeURIComponent(
              conversation.id,
            )}`,
            {
              method: "PATCH",
              body: JSON.stringify({
                pinned:
                  !conversation.pinned,
              }),
            },
          );

        setConversations(
          (current) =>
            current.map(
              (item) =>
                item.id ===
                data.conversation.id
                  ? data.conversation
                  : item,
            ),
        );
      } catch (pinError) {
        setError(
          pinError instanceof Error
            ? pinError.message
            : String(pinError),
        );
      }
    },
    [requestJson],
  );

  const deleteConversation =
    useCallback(
      async (conversationId) => {
        const confirmed =
          window.confirm(
            "ยืนยันการลบบทสนทนานี้หรือไม่?",
          );

        if (!confirmed) {
          return;
        }

        try {
          await requestJson(
            `/api/text-chat/conversations/${encodeURIComponent(
              conversationId,
            )}`,
            {
              method: "DELETE",
            },
          );

          const remaining =
            conversations.filter(
              (conversation) =>
                conversation.id !==
                conversationId,
            );

          setConversations(
            remaining,
          );

          setActiveConversationId(
            remaining[0]?.id || "",
          );
        } catch (deleteError) {
          setError(
            deleteError instanceof Error
              ? deleteError.message
              : String(deleteError),
          );
        }
      },
      [
        conversations,
        requestJson,
      ],
    );

  return (
    <section className="persistent-text-chat">
      <aside className="persistent-chat-sidebar">
        <div className="persistent-chat-sidebar-header">
          <div>
            <span className="text-model-eyebrow">
              Text Chat
            </span>

            <h2>
              ประวัติการสนทนา
            </h2>
          </div>

          <button
            type="button"
            className="m3-btn m3-btn-filled"
            disabled={saving}
            onClick={createConversation}
          >
            <MessageSquarePlus size={16} />
            แชทใหม่
          </button>
        </div>

        <label className="persistent-chat-search">
          <Search size={16} />

          <input
            type="search"
            value={search}
            placeholder="ค้นหาประวัติแชท"
            onChange={(event) =>
              setSearch(
                event.target.value,
              )
            }
          />
        </label>

        <div className="persistent-chat-list">
          {filteredConversations.map(
            (conversation) => (
              <button
                key={conversation.id}
                type="button"
                className={
                  "persistent-chat-list-item " +
                  (
                    conversation.id ===
                    activeConversationId
                      ? "persistent-chat-list-item-active"
                      : ""
                  )
                }
                onClick={() =>
                  setActiveConversationId(
                    conversation.id,
                  )
                }
              >
                <div>
                  <strong>
                    {conversation.title}
                  </strong>

                  <span>
                    {formatDate(
                      conversation.updatedAt,
                    )}
                  </span>
                </div>

                {conversation.pinned && (
                  <Pin size={14} />
                )}
              </button>
            ),
          )}
        </div>
      </aside>

      <div className="persistent-chat-main">
        <header className="persistent-chat-header">
          <div>
            <span className="text-model-eyebrow">
              Conversation
            </span>

            <h2>
              {activeConversation?.title ||
                "เริ่มบทสนทนาใหม่"}
            </h2>

            <p>
              บันทึกอัตโนมัติทุกข้อความ
              และเปิดกลับมาได้หลัง Refresh
              หรือเปิดแอปใหม่
            </p>
          </div>

          <div className="persistent-chat-header-actions">
            {activeConversation && (
              <>
                <button
                  type="button"
                  className="m3-btn m3-btn-outlined"
                  onClick={() =>
                    togglePin(
                      activeConversation,
                    )
                  }
                >
                  <Pin size={15} />
                  {activeConversation.pinned
                    ? "เลิกปักหมุด"
                    : "ปักหมุด"}
                </button>

                <button
                  type="button"
                  className="m3-btn m3-btn-error"
                  onClick={() =>
                    deleteConversation(
                      activeConversation.id,
                    )
                  }
                >
                  <Trash2 size={15} />
                  ลบ
                </button>
              </>
            )}

            <button
              type="button"
              className="m3-btn m3-btn-outlined"
              onClick={refresh}
            >
              <RefreshCw size={15} />
              รีเฟรช
            </button>
          </div>
        </header>

        {memoryStatus && (
          <section className="persistent-chat-memory-panel">
            <div className="persistent-chat-memory-heading">
              <div>
                <strong>
                  Conversation Memory
                </strong>

                <span>
                  ระบบรักษาบริบทและรีเฟรชเซสชันอัตโนมัติ
                </span>
              </div>

              <div className="persistent-chat-memory-actions">
                <button
                  type="button"
                  className="m3-btn m3-btn-outlined"
                  disabled={optimizingMemory}
                  onClick={optimizeMemory}
                >
                  {optimizingMemory
                    ? "กำลังเพิ่มประสิทธิภาพ..."
                    : "สร้าง Memory Snapshot"}
                </button>

                <button
                  type="button"
                  className="m3-btn m3-btn-filled"
                  disabled={refreshingRuntime}
                  onClick={() =>
                    refreshRuntimeSession({
                      automatic: false,
                    })
                  }
                >
                  {refreshingRuntime
                    ? "กำลัง Reload Model..."
                    : "Reload Model Runtime"}
                </button>
              </div>
            </div>

            <div className="persistent-chat-memory-grid">
              <div>
                <span>Context</span>
                <strong>
                  {memoryStatus.context
                    ?.usagePercent || 0}%
                </strong>
              </div>

              <div>
                <span>Token โดยประมาณ</span>
                <strong>
                  {(memoryStatus.context
                    ?.estimatedTokens || 0)
                    .toLocaleString()}
                </strong>
              </div>

              <div>
                <span>RAM ใช้งาน</span>
                <strong>
                  {memoryStatus.ram
                    ?.usedPercent || 0}%
                </strong>
              </div>

              <div>
                <span>Session Refresh</span>
                <strong>
                  {memoryStatus.session
                    ?.refreshCount || 0}
                </strong>
              </div>

              <div>
                <span>Memory Facts</span>
                <strong>
                  {memoryStatus.memory
                    ?.factCount || 0}
                </strong>
              </div>

              <div>
                <span>Snapshots</span>
                <strong>
                  {memoryStatus.memory
                    ?.snapshotCount || 0}
                </strong>
              </div>
            </div>

            <div className="persistent-chat-memory-status">
              <span>
                Context Action:
                {" "}
                {memoryStatus.context
                  ?.action || "none"}
              </span>

              <span>
                RAM Action:
                {" "}
                {memoryStatus.ram
                  ?.action || "none"}
              </span>

              <span>
                {memoryStatus.memory
                  ?.hasSummary
                  ? "สรุปบริบทพร้อมใช้งาน"
                  : "ยังไม่ต้องสรุปบริบท"}
              </span>
            </div>

            <div className="persistent-chat-runtime-status">
              <span>
                Runtime:
                {" "}
                {runtimeSession?.status ||
                  "idle"}
              </span>

              <span>
                {runtimeSession?.runtimeOffline
                  ? "Runtime Offline — Memory Prepared"
                  : "Runtime Adapter พร้อมใช้งาน"}
              </span>

              <span>
                Restore Prompt:
                {" "}
                {runtimeSession
                  ?.restorePromptCharacters || 0}
                {" "}
                ตัวอักษร
              </span>
            </div>
          </section>
        )}

        {error && (
          <div className="text-model-manager-error">
            {error}
          </div>
        )}

        <div className="persistent-chat-messages">
          {loading ? (
            <div className="persistent-chat-empty">
              กำลังโหลดประวัติแชท...
            </div>
          ) : activeConversation?.messages
              ?.length ? (
            activeConversation.messages.map(
              (message) => (
                <article
                  key={message.id}
                  className={
                    "persistent-chat-message " +
                    `persistent-chat-message-${message.role}`
                  }
                >
                  <div>
                    {message.role === "user"
                      ? "คุณ"
                      : message.role}
                  </div>

                  <p>
                    {message.content}
                  </p>

                  <time>
                    {formatDate(
                      message.createdAt,
                    )}
                  </time>

                  {message.role ===
                    "assistant" && (
                    <div className="persistent-chat-feedback-actions">
                      <button
                        type="button"
                        title="ชอบคำตอบนี้"
                        className={
                          message.metadata
                            ?.userFeedback ===
                            "like"
                            ? "persistent-chat-feedback-active"
                            : ""
                        }
                        disabled={
                          feedbackBusyId ===
                          message.id
                        }
                        onClick={() =>
                          submitMessageFeedback(
                            message,
                            message.metadata
                              ?.userFeedback ===
                              "like"
                              ? "clear"
                              : "like",
                          )
                        }
                      >
                        <ThumbsUp
                          size={14}
                        />
                      </button>

                      <button
                        type="button"
                        title="ไม่ชอบคำตอบนี้"
                        className={
                          message.metadata
                            ?.userFeedback ===
                            "dislike"
                            ? "persistent-chat-feedback-active"
                            : ""
                        }
                        disabled={
                          feedbackBusyId ===
                          message.id
                        }
                        onClick={() =>
                          submitMessageFeedback(
                            message,
                            message.metadata
                              ?.userFeedback ===
                              "dislike"
                              ? "clear"
                              : "dislike",
                          )
                        }
                      >
                        <ThumbsDown
                          size={14}
                        />
                      </button>

                      <button
                        type="button"
                        title="เลือกเป็นคำตอบที่ต้องการ"
                        className={
                          message.metadata
                            ?.userPreferred
                            ? "persistent-chat-feedback-preferred"
                            : ""
                        }
                        disabled={
                          feedbackBusyId ===
                          message.id
                        }
                        onClick={() =>
                          submitMessageFeedback(
                            message,
                            "preferred",
                          )
                        }
                      >
                        <CheckCircle2
                          size={14}
                        />
                        เลือกคำตอบนี้
                      </button>

                      <button
                        type="button"
                        title="สร้างคำตอบใหม่"
                        disabled={
                          generating ||
                          multiGenerating ||
                          judgeGenerating ||
                          feedbackBusyId ===
                            message.id
                        }
                        onClick={() =>
                          regenerateMessage(
                            message,
                          )
                        }
                      >
                        <RotateCcw
                          size={14}
                        />
                        Regenerate
                      </button>
                    </div>
                  )}
                </article>
              ),
            )
          ) : (
            <div className="persistent-chat-empty">
              เริ่มพิมพ์ข้อความได้เลย
              ระบบจะบันทึกประวัติให้อัตโนมัติ
            </div>
          )}

          {generating && (
            <article className="persistent-chat-message persistent-chat-message-assistant persistent-chat-message-streaming">
              <div>
                assistant
              </div>

              <p>
                {streamingResponse ||
                  "กำลังประมวลผล..."}

                <span className="persistent-chat-streaming-cursor">
                  ▍
                </span>
              </p>
            </article>
          )}
        </div>

        <section className="persistent-chat-multi-model-panel">
          <div className="persistent-chat-multi-model-heading">
            <div>
              <strong>
                Multi-Model Comparison
              </strong>

              <span>
                เลือกได้สูงสุด 3 โมเดล
                และประมวลผลพร้อมกัน
              </span>
            </div>

            <label className="persistent-chat-multi-model-toggle">
              <input
                type="checkbox"
                checked={multiModelEnabled}
                disabled={
                  generating ||
                  multiGenerating
                }
                onChange={(event) =>
                  setMultiModelEnabled(
                    event.target.checked,
                  )
                }
              />

              เปิดใช้งาน
            </label>
          </div>

          {multiModelEnabled && (
            <>
              <div className="persistent-chat-model-selector">
                {availableModels.map(
                  (model) => {
                    const selected =
                      selectedModelIds.includes(
                        model.modelId,
                      );

                    const selectionFull =
                      selectedModelIds.length >=
                        3 &&
                      !selected;

                    return (
                      <label
                        key={
                          model.modelId
                        }
                        className={
                          "persistent-chat-model-option " +
                          (
                            selected
                              ? "persistent-chat-model-option-selected"
                              : ""
                          )
                        }
                      >
                        <input
                          type="checkbox"
                          checked={selected}
                          disabled={
                            selectionFull ||
                            generating ||
                            multiGenerating
                          }
                          onChange={() =>
                            setSelectedModelIds(
                              (current) =>
                                selected
                                  ? current.filter(
                                      (
                                        modelId,
                                      ) =>
                                        modelId !==
                                        model.modelId,
                                    )
                                  : [
                                      ...current,
                                      model.modelId,
                                    ].slice(
                                      0,
                                      3,
                                    ),
                            )
                          }
                        />

                        <span>
                          <strong>
                            {model.modelName ||
                              model.modelId}
                          </strong>

                          <small>
                            {model.quantization ||
                              model.variantId ||
                              model.version}
                          </small>
                        </span>
                      </label>
                    );
                  },
                )}
              </div>

              {(multiGenerating ||
                Object.keys(
                  multiResponses,
                ).length > 0) && (
                <div className="persistent-chat-multi-results">
                  {selectedModelIds.map(
                    (modelId) => {
                      const model =
                        availableModels.find(
                          (item) =>
                            item.modelId ===
                            modelId,
                        );

                      const evaluated =
                        multiEvaluation
                          ?.responses?.find(
                            (item) =>
                              item.modelId ===
                              modelId,
                          );

                      return (
                        <article
                          key={modelId}
                          className={
                            "persistent-chat-model-result " +
                            (
                              evaluated?.best
                                ? "persistent-chat-model-result-best"
                                : ""
                            )
                          }
                        >
                          <header>
                            <div>
                              <strong>
                                {model?.modelName ||
                                  modelId}
                              </strong>

                              <span>
                                {model?.quantization ||
                                  ""}
                              </span>
                            </div>

                            {evaluated?.best && (
                              <span className="persistent-chat-best-chip">
                                Best Response
                              </span>
                            )}
                          </header>

                          <p>
                            {multiResponses[
                              modelId
                            ] ||
                              (
                                multiGenerating
                                  ? "กำลังประมวลผล..."
                                  : "ไม่มีคำตอบ"
                              )}
                          </p>

                          {evaluated && (
                            <footer>
                              <span>
                                คะแนน:
                                {" "}
                                {(
                                  evaluated.score *
                                  100
                                ).toFixed(1)}
                              </span>

                              <span>
                                อันดับ:
                                {" "}
                                {evaluated.rank}
                              </span>
                            </footer>
                          )}
                        </article>
                      );
                    },
                  )}
                </div>
              )}

              {multiEvaluation?.responses
                ?.length > 0 && (
                <section className="persistent-chat-judge-panel">
                  <div className="persistent-chat-judge-heading">
                    <div>
                      <strong>
                        AI Judge Final Answer
                      </strong>

                      <span>
                        รวมจุดแข็งของทุกโมเดลเป็นคำตอบสุดท้ายเดียว
                      </span>
                    </div>

                    {judgeGenerating ? (
                      <button
                        type="button"
                        className="m3-btn m3-btn-error"
                        onClick={
                          stopJudgeSynthesis
                        }
                      >
                        หยุด AI Judge
                      </button>
                    ) : (
                      <button
                        type="button"
                        className="m3-btn m3-btn-filled"
                        onClick={
                          generateJudgeSynthesis
                        }
                      >
                        สร้าง Final Answer
                      </button>
                    )}
                  </div>

                  {(judgeGenerating ||
                    judgeResponse) && (
                    <article className="persistent-chat-judge-result">
                      <header>
                        <strong>
                          Final Answer
                        </strong>

                        {judgeFallback && (
                          <span className="persistent-chat-judge-fallback">
                            Best Response Fallback
                          </span>
                        )}
                      </header>

                      <p>
                        {judgeResponse ||
                          "กำลังวิเคราะห์และรวมคำตอบ..."}

                        {judgeGenerating && (
                          <span className="persistent-chat-streaming-cursor">
                            ▍
                          </span>
                        )}
                      </p>
                    </article>
                  )}
                </section>
              )}
            </>
          )}
        </section>

        <div className="persistent-chat-composer">
          <textarea
            value={draft}
            placeholder="พิมพ์ข้อความต่อเนื่องได้ที่นี่..."
            onChange={(event) =>
              setDraft(
                event.target.value,
              )
            }
            onKeyDown={(event) => {
              if (
                event.key === "Enter" &&
                !event.shiftKey &&
                !generating
              ) {
                event.preventDefault();
                sendMessage();
              }
            }}
          />

          <div className="persistent-chat-composer-footer">
            <span>
              <Save size={14} />
              Autosave เปิดใช้งาน
            </span>

            {multiGenerating ? (
              <button
                type="button"
                className="m3-btn m3-btn-error"
                onClick={
                  stopMultiModelGeneration
                }
              >
                หยุดทุกโมเดล
              </button>
            ) : generating ? (
              <button
                type="button"
                className="m3-btn m3-btn-error"
                onClick={stopGeneration}
              >
                หยุดการสร้างคำตอบ
              </button>
            ) : (
              <button
                type="button"
                className="m3-btn m3-btn-filled"
                disabled={
                  saving ||
                  generating ||
                  multiGenerating ||
                  !draft.trim() ||
                  (
                    multiModelEnabled &&
                    selectedModelIds.length ===
                      0
                  )
                }
                onClick={sendMessage}
              >
                <Send size={16} />
                ส่งข้อความ
              </button>
            )}
          </div>
        </div>
      </div>
    </section>
  );
}
