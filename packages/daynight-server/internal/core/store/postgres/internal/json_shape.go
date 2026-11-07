package pg

import (
	"fmt"
	"reflect"
	"strings"
	"time"
)

var timeType = reflect.TypeOf(time.Time{})

// JSONFold implements encoding/json's case-insensitive struct field matching
// for ASCII field names, including Unicode simple-fold equivalents of K and S.
func JSONFold(key string) string {
	return `lower(replace(replace(` + key + `, 'K','k'), 'ſ','s') COLLATE "C")`
}

// CompactJSONTime bounds a timestamp's transferred text without changing the
// time parsed by Go, which accepts arbitrarily many fractional digits.
func CompactJSONTime(expr string) string {
	pattern := `^(.{18,19}[.,][0-9]{9})[0-9]+(Z|[+-][0-9]{2}:[0-9]{2})$`
	return `CASE WHEN octet_length(` + expr + `) > 512 THEN CASE WHEN ` + expr + ` ~ '` + pattern + `' THEN regexp_replace(` + expr + `, '` + pattern + `', '\1\2') ELSE 'invalid' END ELSE ` + expr + ` END`
}

type jsonShapeBuilder struct{ next int }

func (b *jsonShapeBuilder) alias() string { b.next++; return fmt.Sprintf("shape%d", b.next) }
func nullableKind(expr, kind string) string {
	return `coalesce(jsonb_typeof(` + expr + `) NOT IN ('` + kind + `','null'), false)`
}

// JSONShapeError produces a bounded SQL type check equivalent to decoding the
// supported JSON shapes into typ. Unknown members are ignored, as in Go.
func JSONShapeError(expr string, typ reflect.Type) string {
	return (&jsonShapeBuilder{}).bad(expr, typ)
}
func (b *jsonShapeBuilder) bad(expr string, typ reflect.Type) string {
	for typ.Kind() == reflect.Pointer {
		typ = typ.Elem()
	}
	if typ == timeType {
		return JSONTimestampInvalid(expr)
	}
	switch typ.Kind() {
	case reflect.Struct:
		a := b.alias()
		cases := make([]string, 0, typ.NumField())
		for i := 0; i < typ.NumField(); i++ {
			f := typ.Field(i)
			if !f.IsExported() {
				continue
			}
			tag := strings.Split(f.Tag.Get("json"), ",")[0]
			if tag == "-" {
				continue
			}
			if tag == "" {
				tag = f.Name
			}
			cases = append(cases, `WHEN '`+strings.ToLower(tag)+`' THEN (`+b.bad(`(`+expr+`->`+a+`.key)`, f.Type)+`)`)
		}
		return `(` + nullableKind(expr, "object") + ` OR EXISTS (SELECT 1 FROM jsonb_object_keys(CASE WHEN jsonb_typeof(` + expr + `)='object' THEN ` + expr + ` ELSE '{}'::jsonb END) AS ` + a + `(key) WHERE CASE ` + JSONFold(a+".key") + ` ` + strings.Join(cases, " ") + ` ELSE false END))`

	case reflect.Slice, reflect.Array:
		a := b.alias()
		child := b.bad(a+".value", typ.Elem())
		return `(` + nullableKind(expr, "array") + ` OR EXISTS (SELECT 1 FROM jsonb_array_elements(CASE WHEN jsonb_typeof(` + expr + `)='array' THEN ` + expr + ` ELSE '[]'::jsonb END) AS ` + a + `(value) WHERE ` + child + `))`
	case reflect.String:
		return nullableKind(expr, "string")
	case reflect.Bool:
		return nullableKind(expr, "boolean")
	case reflect.Int, reflect.Int8, reflect.Int16, reflect.Int32, reflect.Int64:
		return `(` + nullableKind(expr, "number") + ` OR CASE WHEN jsonb_typeof(` + expr + `)='number' THEN NOT pg_input_is_valid(` + expr + `#>>'{}','bigint') ELSE false END)`
	case reflect.Float32, reflect.Float64:
		return `(` + nullableKind(expr, "number") + ` OR CASE WHEN jsonb_typeof(` + expr + `)='number' AND abs((` + expr + `#>>'{}')::numeric)>=1 THEN NOT pg_input_is_valid(` + expr + `#>>'{}','double precision') ELSE false END)`
	default:
		panic("unsupported JSON projection type: " + typ.String())
	}
}

// JSONTimes returns SELECT statements yielding bounded timestamp text for every
// matching field, including aliases later overwritten by another JSON key.
func JSONTimes(expr string, typ reflect.Type) []string {
	b := &jsonShapeBuilder{}
	return b.times(expr, typ, nil, nil)
}
func (b *jsonShapeBuilder) times(expr string, typ reflect.Type, from, where []string) []string {
	for typ.Kind() == reflect.Pointer {
		typ = typ.Elem()
	}
	if typ == timeType {
		if len(from) == 0 {
			panic("root timestamp is unsupported")
		}
		conditions := append(append([]string{}, where...), `jsonb_typeof(`+expr+`)='string'`)
		return []string{`SELECT ` + CompactJSONTime(expr+`#>>'{}'`) + ` FROM ` + strings.Join(from, ` CROSS JOIN LATERAL `) + ` WHERE ` + strings.Join(conditions, ` AND `)}
	}
	switch typ.Kind() {
	case reflect.Struct:
		var out []string
		for i := 0; i < typ.NumField(); i++ {
			f := typ.Field(i)
			if !f.IsExported() {
				continue
			}
			tag := strings.Split(f.Tag.Get("json"), ",")[0]
			if tag == "-" {
				continue
			}
			if tag == "" {
				tag = f.Name
			}
			a := b.alias()
			source := `jsonb_each(CASE WHEN jsonb_typeof(` + expr + `)='object' THEN ` + expr + ` ELSE '{}'::jsonb END) AS ` + a
			fs := append(append([]string{}, from...), source)
			ws := append(append([]string{}, where...), JSONFold(a+".key")+`='`+strings.ToLower(tag)+`'`)
			out = append(out, b.times(a+".value", f.Type, fs, ws)...)
		}
		return out
	case reflect.Slice, reflect.Array:
		a := b.alias()
		source := `jsonb_array_elements(CASE WHEN jsonb_typeof(` + expr + `)='array' THEN ` + expr + ` ELSE '[]'::jsonb END) AS ` + a + `(value)`
		return b.times(a+".value", typ.Elem(), append(append([]string{}, from...), source), where)
	default:
		return nil
	}
}

// JSONTimestampInvalid mirrors Go's RFC3339 parser, including its permissive
// one-digit hour, comma fraction and 24:60 numeric timezone offset. Captured
// fields are fixed width, so even long fractions are not materialized in Go.
func JSONTimestampInvalid(expr string) string {
	raw := expr + `#>>'{}'`
	pattern := `^([0-9]{4})-([0-9]{2})-([0-9]{2})T([0-9]{1,2}):([0-9]{2}):([0-9]{2})(?:[.,][0-9]+)?(?:Z|([+-])([0-9]{2}):([0-9]{2}))$`
	return `(` + nullableKind(expr, "string") + ` OR CASE WHEN jsonb_typeof(` + expr + `)='string' THEN NOT coalesce((SELECT m IS NOT NULL AND
        m[2]::int BETWEEN 1 AND 12 AND m[3]::int BETWEEN 1 AND CASE m[2]::int WHEN 2 THEN CASE WHEN m[1]::int%4=0 AND (m[1]::int%100<>0 OR m[1]::int%400=0) THEN 29 ELSE 28 END WHEN 4 THEN 30 WHEN 6 THEN 30 WHEN 9 THEN 30 WHEN 11 THEN 30 ELSE 31 END
        AND m[4]::int<=23 AND m[5]::int<=59 AND m[6]::int<=59 AND (m[7] IS NULL OR (m[8]::int<=24 AND m[9]::int<=60))
        FROM (SELECT regexp_match(` + raw + `, '` + pattern + `') AS m) parsed),false) ELSE false END)`
}
