package mcp

import (
	"embed"
	"fmt"
	"io/fs"
	"regexp"
	"strings"
	"unicode/utf8"

	sdk "github.com/modelcontextprotocol/go-sdk/mcp"
)

//go:embed manuals/*.md
var productManualFS embed.FS

type manualDocument struct {
	Resource sdk.Resource
	Text     string
}

// manualLoadError identifies the fixed manifest key without exposing source errors in logs.
type manualLoadError struct {
	Key string
	Err error
}

func (e *manualLoadError) Error() string { return fmt.Sprintf("manual %q: %v", e.Key, e.Err) }
func (e *manualLoadError) Unwrap() error { return e.Err }

type productManuals struct {
	Instructions string
	Documents    []manualDocument
}

type manualManifestEntry struct {
	Path     string
	Resource sdk.Resource
}

// The manifest is explicit: public identifiers and metadata do not derive from
// a request URI or the contents of the embedded directory.
var productManualManifest = []manualManifestEntry{
	{"manuals/concepts.md", sdk.Resource{URI: "daynight://manuals/concepts.md", Name: "concepts", Title: "Account, Team and Project context", Description: "Establish Account, Team and Project context and manage a Project repository.", MIMEType: "text/markdown", Size: 11103}},
	{"manuals/tasks.md", sdk.Resource{URI: "daynight://manuals/tasks.md", Name: "tasks", Title: "Task and Goal reads", Description: "Inspect Task and Goal definitions, projections, readiness, inventories and properties.", MIMEType: "text/markdown", Size: 8835}},
	{"manuals/task-writes.md", sdk.Resource{URI: "daynight://manuals/task-writes.md", Name: "task-writes", Title: "Task and Goal writes", Description: "Create, modify or delete Tasks and Goals alongside write-safety; consult dependency-writes when changing relationships.", MIMEType: "text/markdown", Size: 10957}},
	{"manuals/dependencies.md", sdk.Resource{URI: "daynight://manuals/dependencies.md", Name: "dependencies", Title: "Dependency graphs and Goal relationships", Description: "Interpret ordinary Task graphs and Goal acceptance relationships.", MIMEType: "text/markdown", Size: 5069}},
	{"manuals/dependency-writes.md", sdk.Resource{URI: "daynight://manuals/dependency-writes.md", Name: "dependency-writes", Title: "Edit dependencies", Description: "Edit ordinary Task and Goal acceptance relationships with write-safety.", MIMEType: "text/markdown", Size: 6898}},
	{"manuals/write-safety.md", sdk.Resource{URI: "daynight://manuals/write-safety.md", Name: "write-safety", Title: "Write safety", Description: "Apply authorization, exact versions, completion facts and unknown-write recovery to every write.", MIMEType: "text/markdown", Size: 6342}},
	{"manuals/materials.md", sdk.Resource{URI: "daynight://manuals/materials.md", Name: "materials", Title: "Task and Goal materials", Description: "Keep Task and Goal requirements, conclusions, sources and results with their effective owner.", MIMEType: "text/markdown", Size: 5631}},
	{"manuals/threads.md", sdk.Resource{URI: "daynight://manuals/threads.md", Name: "threads", Title: "Task discussion Threads", Description: "Consume complete discussion pages and post immutable messages with write-safety.", MIMEType: "text/markdown", Size: 3659}},
	{"manuals/attachment-reads.md", sdk.Resource{URI: "daynight://manuals/attachment-reads.md", Name: "attachment-reads", Title: "Attachment reads and references", Description: "Resolve attachment paths and read complete inline bytes or immutable download snapshots.", MIMEType: "text/markdown", Size: 5916}},
	{"manuals/attachment-writes.md", sdk.Resource{URI: "daynight://manuals/attachment-writes.md", Name: "attachment-writes", Title: "Publish and remove attachments", Description: "Publish and remove attachments with write-safety; read attachment-reads for paths or byte verification.", MIMEType: "text/markdown", Size: 5538}},
	{"manuals/session-reads.md", sdk.Resource{URI: "daynight://manuals/session-reads.md", Name: "session-reads", Title: "Session observations and selection", Description: "Observe work, interpret freshness and select exact Sessions; use session-history for content.", MIMEType: "text/markdown", Size: 6949}},
	{"manuals/session-history.md", sdk.Resource{URI: "daynight://manuals/session-history.md", Name: "session-history", Title: "Session history and complete entries", Description: "Read bounded history pages and complete entries for an exact retained Session.", MIMEType: "text/markdown", Size: 4046}},
	{"manuals/session-messages.md", sdk.Resource{URI: "daynight://manuals/session-messages.md", Name: "session-messages", Title: "Session messages and original operation recovery", Description: "Send with retained Session/execution identity and intent or query the original operation alongside write-safety; use session-reads when target identity is unknown.", MIMEType: "text/markdown", Size: 4603}},
	{"manuals/worker-operations.md", sdk.Resource{URI: "daynight://manuals/worker-operations.md", Name: "worker-operations", Title: "Worker assignment and claim completion", Description: "Distinguish handoff, explicit assignment, owned claim completion and host process control; complete claims alongside write-safety.", MIMEType: "text/markdown", Size: 5555}},
	{"manuals/overview.md", sdk.Resource{URI: "daynight://manuals/overview.md", Name: "overview", Title: "Daynight MCP overview", Description: "Find operation guides, shared conventions and required reading sets.", MIMEType: "text/markdown", Size: 4605}},
}

var manualURIReference = regexp.MustCompile(`daynight://manuals/[^\s\]\[()<>"` + "`" + `]+`)

func loadProductManuals(source fs.FS) (productManuals, error) {
	return loadManualManifest(source, productManualManifest)
}

func loadManualManifest(source fs.FS, manifest []manualManifestEntry) (productManuals, error) {
	if len(manifest) == 0 || len(manifest) != len(productManualManifest) {
		return productManuals{}, &manualLoadError{Key: "catalog", Err: fmt.Errorf("expected %d topics, got %d", len(productManualManifest), len(manifest))}
	}
	expected := make(map[string]bool, len(productManualManifest))
	for _, entry := range productManualManifest {
		expected[entry.Resource.Name] = true
	}
	uris, names := make(map[string]bool, len(manifest)), make(map[string]bool, len(manifest))
	for _, item := range manifest {
		r := item.Resource
		if !expected[r.Name] || r.URI != "daynight://manuals/"+r.Name+".md" || item.Path != "manuals/"+r.Name+".md" || !fs.ValidPath(item.Path) || strings.ContainsAny(r.Name, "/\\") || strings.TrimSpace(r.Title) == "" || strings.TrimSpace(r.Description) == "" || r.MIMEType != "text/markdown" || r.Size <= 0 {
			return productManuals{}, &manualLoadError{Key: "catalog", Err: fmt.Errorf("invalid metadata for %q", r.Name)}
		}
		if uris[r.URI] || names[r.Name] {
			return productManuals{}, &manualLoadError{Key: "catalog", Err: fmt.Errorf("duplicate URI or name for %q", r.Name)}
		}
		uris[r.URI], names[r.Name] = true, true
	}
	instructions, err := readManualText(source, "manuals/instructions.md", "instructions")
	if err != nil {
		return productManuals{}, err
	}
	if err := validateManualReferences(instructions, "instructions", uris, names); err != nil {
		return productManuals{}, err
	}
	result := productManuals{Instructions: instructions, Documents: make([]manualDocument, 0, len(manifest))}
	for _, item := range manifest {
		r := item.Resource
		body, err := readManualText(source, item.Path, r.Name)
		if err != nil {
			return productManuals{}, err
		}
		if int64(len(body)) != r.Size {
			return productManuals{}, &manualLoadError{Key: r.Name, Err: fmt.Errorf("size mismatch: got %d, want %d", len(body), r.Size)}
		}
		if err := validateManualReferences(body, r.Name, uris, names); err != nil {
			return productManuals{}, err
		}
		result.Documents = append(result.Documents, manualDocument{Resource: r, Text: body})
	}
	return result, nil
}

func validateManualReferences(text, key string, uris, names map[string]bool) error {
	for _, uri := range manualURIReference.FindAllString(text, -1) {
		if !uris[uri] {
			return &manualLoadError{Key: key, Err: fmt.Errorf("unknown product reference %q", uri)}
		}
	}
	for name := range names {
		if strings.Contains(text, "]("+name+".md)") {
			return &manualLoadError{Key: key, Err: fmt.Errorf("relative product reference to %q", name)}
		}
	}
	return nil
}

func readManualText(source fs.FS, path, key string) (string, error) {
	data, err := fs.ReadFile(source, path)
	if err != nil {
		return "", &manualLoadError{Key: key, Err: fmt.Errorf("read: %w", err)}
	}
	if !utf8.Valid(data) || strings.TrimSpace(string(data)) == "" {
		return "", &manualLoadError{Key: key, Err: fmt.Errorf("content must be nonempty UTF-8")}
	}
	return string(data), nil
}

func registerProductManuals(server *sdk.Server, manuals productManuals, handler func(manualDocument) sdk.ResourceHandler) {
	for _, document := range manuals.Documents {
		resource := document.Resource
		server.AddResource(&resource, handler(document))
	}
}
