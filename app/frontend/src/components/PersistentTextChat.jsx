import {
  MessageSquarePlus,
  Pin,
  RefreshCw,
  Save,
  Search,
  Send,
  Trash2,
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

  const sendMessage =
    useCallback(
      async () => {
        const content =
          draft.trim();

        if (!content) {
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

          window.setTimeout(
            () => {
              refreshMemoryStatus(
                conversationId,
              );
            },
            250,
          );
        } catch (sendError) {
          setError(
            sendError instanceof Error
              ? sendError.message
              : String(sendError),
          );
        } finally {
          setSaving(false);
        }
      },
      [
        activeConversationId,
        draft,
        requestJson,
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
                </article>
              ),
            )
          ) : (
            <div className="persistent-chat-empty">
              เริ่มพิมพ์ข้อความได้เลย
              ระบบจะบันทึกประวัติให้อัตโนมัติ
            </div>
          )}
        </div>

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
                !event.shiftKey
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

            <button
              type="button"
              className="m3-btn m3-btn-filled"
              disabled={
                saving ||
                !draft.trim()
              }
              onClick={sendMessage}
            >
              <Send size={16} />
              ส่งข้อความ
            </button>
          </div>
        </div>
      </div>
    </section>
  );
}
