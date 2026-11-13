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
	{"manuals/concepts.md", sdk.Resource{URI: "daynight://manuals/concepts.md", Name: "concepts", Title: "Account, Project and product context", Description: "Establish Account and Project identity, resolve a repository, and distinguish product objects, Team kinds and host capabilities.", MIMEType: "text/markdown", Size: 7511}},
	{"manuals/tasks.md", sdk.Resource{URI: "daynight://manuals/tasks.md", Name: "tasks", Title: "Task and Goal reads and lifecycle", Description: "Create and organize Tasks and Goals, choose projections, list ready work, and change lifecycle or properties alongside write-safety.", MIMEType: "text/markdown", Size: 16813}},
	{"manuals/dependencies.md", sdk.Resource{URI: "daynight://manuals/dependencies.md", Name: "dependencies", Title: "Dependency graphs and replacement", Description: "Read ordinary and external prerequisites, replace the complete dependency sets with write-safety, and verify or reduce graph edges.", MIMEType: "text/markdown", Size: 9689}},
	{"manuals/write-safety.md", sdk.Resource{URI: "daynight://manuals/write-safety.md", Name: "write-safety", Title: "Shared write safety", Description: "Read for every write alongside its operation topic: authorization, exact versions, conflict reassessment and confirmed/not_committed/unknown outcomes.", MIMEType: "text/markdown", Size: 8196}},
	{"manuals/materials.md", sdk.Resource{URI: "daynight://manuals/materials.md", Name: "materials", Title: "Task material ownership", Description: "Organize Goal outcomes and progress, child Task results, discussion and execution context; preserve complete formal material and readable shared references.", MIMEType: "text/markdown", Size: 9107}},
	{"manuals/steps.md", sdk.Resource{URI: "daynight://manuals/steps.md", Name: "steps", Title: "Step reads and writes", Description: "Read complete ordered Step collections and use parent Task versions and stable Step IDs for writes alongside write-safety.", MIMEType: "text/markdown", Size: 5749}},
	{"manuals/threads.md", sdk.Resource{URI: "daynight://manuals/threads.md", Name: "threads", Title: "Thread reading and posting", Description: "Read complete discussion pages without skipping unread messages; post and investigate uncertain results alongside write-safety.", MIMEType: "text/markdown", Size: 4550}},
	{"manuals/attachment-reads.md", sdk.Resource{URI: "daynight://manuals/attachment-reads.md", Name: "attachment-reads", Title: "Attachment paths and complete reads", Description: "Resolve file references, inspect metadata, read inline content or assemble and close one immutable download snapshot.", MIMEType: "text/markdown", Size: 7602}},
	{"manuals/attachment-writes.md", sdk.Resource{URI: "daynight://manuals/attachment-writes.md", Name: "attachment-writes", Title: "Attachment upload and removal", Description: "Upload inline or retain a chunked upload lifecycle, remove files and verify publication alongside write-safety; read attachment-reads for unknown path rules.", MIMEType: "text/markdown", Size: 7812}},
	{"manuals/session-reads.md", sdk.Resource{URI: "daynight://manuals/session-reads.md", Name: "session-reads", Title: "Session observations, work groups and history", Description: "Interpret ephemeral Task Session observations, page task_work_list groups, locate exact Sessions and read complete history or large entries.", MIMEType: "text/markdown", Size: 11368}},
	{"manuals/session-messages.md", sdk.Resource{URI: "daynight://manuals/session-messages.md", Name: "session-messages", Title: "Session messages and original operation recovery", Description: "Send with retained Session/execution identity and intent or query the original operation alongside write-safety; use session-reads when target identity is unknown.", MIMEType: "text/markdown", Size: 5665}},
	{"manuals/worker-operations.md", sdk.Resource{URI: "daynight://manuals/worker-operations.md", Name: "worker-operations", Title: "Worker assignment and claim completion", Description: "Distinguish handoff, explicit assignment, owned claim completion and host process control; complete claims alongside write-safety.", MIMEType: "text/markdown", Size: 6590}},
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
