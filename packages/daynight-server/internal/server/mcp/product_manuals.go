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
	{"manuals/concepts.md", sdk.Resource{URI: "daynight://manuals/concepts.md", Name: "concepts", Title: "Product concepts", Description: "Objects, account and Project context, repository resolution, and host responsibilities.", MIMEType: "text/markdown", Size: 18423}},
	{"manuals/queries-and-lifecycle.md", sdk.Resource{URI: "daynight://manuals/queries-and-lifecycle.md", Name: "queries-and-lifecycle", Title: "Queries and lifecycle", Description: "Choose Task and related reads, understand projections, pagination, statuses and properties.", MIMEType: "text/markdown", Size: 30931}},
	{"manuals/dependencies.md", sdk.Resource{URI: "daynight://manuals/dependencies.md", Name: "dependencies", Title: "Dependency management", Description: "Read and replace ordinary and external prerequisites, reduce redundant edges and verify the graph.", MIMEType: "text/markdown", Size: 16389}},
	{"manuals/write-safety.md", sdk.Resource{URI: "daynight://manuals/write-safety.md", Name: "write-safety", Title: "Write safety", Description: "Bind decisions to exact versions and distinguish confirmed, rejected and unknown write outcomes.", MIMEType: "text/markdown", Size: 19473}},
	{"manuals/materials.md", sdk.Resource{URI: "daynight://manuals/materials.md", Name: "materials", Title: "Organizing task materials", Description: "Choose the owner of requirements, results, discussion, Steps and execution context.", MIMEType: "text/markdown", Size: 17927}},
	{"manuals/files-and-references.md", sdk.Resource{URI: "daynight://manuals/files-and-references.md", Name: "files-and-references", Title: "Files and references", Description: "Read and upload complete attachments, preserve references and interpret transfer outcomes.", MIMEType: "text/markdown", Size: 20399}},
	{"manuals/operation-boundaries.md", sdk.Resource{URI: "daynight://manuals/operation-boundaries.md", Name: "operation-boundaries", Title: "Operation boundaries", Description: "Distinguish access, authorization, confirmation, handoff, execution and Worker assignments.", MIMEType: "text/markdown", Size: 18259}},
}

var manualURIReference = regexp.MustCompile(`daynight://manuals/[^\s\]\[()<>"` + "`" + `]+`)

func loadProductManuals(source fs.FS) (productManuals, error) {
	return loadManualManifest(source, productManualManifest)
}

func loadManualManifest(source fs.FS, manifest []manualManifestEntry) (productManuals, error) {
	if len(manifest) != 7 {
		return productManuals{}, &manualLoadError{Key: "catalog", Err: fmt.Errorf("expected seven topics, got %d", len(manifest))}
	}
	uris, names := make(map[string]bool), make(map[string]bool)
	expected := map[string]bool{"concepts": true, "queries-and-lifecycle": true, "dependencies": true, "write-safety": true, "materials": true, "files-and-references": true, "operation-boundaries": true}
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
		for _, uri := range manualURIReference.FindAllString(body, -1) {
			if !uris[uri] {
				return productManuals{}, &manualLoadError{Key: r.Name, Err: fmt.Errorf("unknown product reference %q", uri)}
			}
		}
		for _, target := range manifest {
			if strings.Contains(body, "]("+target.Resource.Name+".md)") {
				return productManuals{}, &manualLoadError{Key: r.Name, Err: fmt.Errorf("relative product reference to %q", target.Resource.Name)}
			}
		}
		result.Documents = append(result.Documents, manualDocument{Resource: r, Text: body})
	}
	for _, target := range manifest {
		if strings.Contains(instructions, "]("+target.Resource.Name+".md)") {
			return productManuals{}, &manualLoadError{Key: "instructions", Err: fmt.Errorf("relative product reference to %q", target.Resource.Name)}
		}
	}
	for _, uri := range manualURIReference.FindAllString(instructions, -1) {
		if !uris[uri] {
			return productManuals{}, &manualLoadError{Key: "instructions", Err: fmt.Errorf("unknown product reference %q", uri)}
		}
	}
	return result, nil
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
