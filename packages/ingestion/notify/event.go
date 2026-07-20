package notify

// EventPayload is the versioned, add-only issue.created payload.
type EventPayload struct {
	Version      int        `json:"version"`
	EventType    string     `json:"event_type"`
	Issue        IssueRef   `json:"issue"`
	Project      ProjectRef `json:"project"`
	Environment  string     `json:"environment"`
	DashboardURL string     `json:"dashboard_url,omitempty"`
}

type IssueRef struct {
	ID        string `json:"id"`
	Title     string `json:"title"`
	FirstSeen string `json:"first_seen"`
}

type ProjectRef struct {
	ID   string `json:"id"`
	Name string `json:"name"`
}

// Formatter renders one event for a destination type.
type Formatter interface {
	Format(EventPayload) (body []byte, contentType string, err error)
}

type formatterFunc func(EventPayload) ([]byte, string, error)

func (f formatterFunc) Format(payload EventPayload) ([]byte, string, error) {
	return f(payload)
}

// Formatters is the destination-type formatter registry.
var Formatters = map[string]Formatter{
	"slack": formatterFunc(FormatSlack),
}
