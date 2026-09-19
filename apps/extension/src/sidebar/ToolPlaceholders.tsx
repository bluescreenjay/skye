export function ToolPlaceholders() {
  return (
    <div className="panel-dock">
      <section className="panel-plan" aria-label="workspace plan">
        <p className="panel-plan-label">plan</p>
        <p className="panel-plan-empty">no plan yet</p>
      </section>
      <section className="actions" aria-label="suggested actions">
        <button type="button" className="btn" disabled>
          summarize
        </button>
        <button type="button" className="btn" disabled>
          collect refs
        </button>
        <button type="button" className="btn" disabled>
          new artifact
        </button>
      </section>
      <section className="chat" aria-label="workspace chat">
        <div className="chat-log">
          <div className="chat-empty">nothing asked yet</div>
        </div>
        <input
          className="ask"
          type="text"
          disabled
          placeholder="ask the workspace anything"
          aria-label="chat is coming later"
        />
      </section>
    </div>
  );
}
