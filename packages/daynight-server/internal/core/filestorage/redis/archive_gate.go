package redis

import (
	"context"
	"crypto/rand"
	"errors"
	"fmt"
	"io"
	"strconv"
	"time"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/filestorage"
	redisclient "github.com/redis/go-redis/v9"
)

// Old releases store an unprefixed random token at this same string key.
// They regard our prefixed value as occupied, and their token comparisons
// cannot renew or delete it. Invalid records are treated as occupied.
var archiveGate = redisclient.NewScript(`
local prefix = 'dn-archive-v1:'
local value = redis.call('GET', KEYS[1])
local entries = {}
if value then
  if string.sub(value, 1, #prefix) ~= prefix then return 0 end
  local ok, decoded = pcall(cjson.decode, string.sub(value, #prefix + 1))
  if not ok or type(decoded) ~= 'table' or #decoded == 0 then return 0 end
  local tokens, sessions, count, cleanups = {}, {}, 0, 0
  for k, e in pairs(decoded) do
    if type(k) ~= 'number' or k < 1 or k > #decoded or k ~= math.floor(k) or
       type(e) ~= 'table' or type(e.token) ~= 'string' or e.token == '' or
       type(e.session) ~= 'string' or type(e.expires) ~= 'number' or
       e.expires <= 0 or e.expires ~= math.floor(e.expires) or
       type(e.cleanup) ~= 'boolean' or tokens[e.token] then return 0 end
    tokens[e.token] = true
    count = count + 1
    if e.cleanup then
      cleanups = cleanups + 1
    else
      if e.session == '' or sessions[e.session] then return 0 end
      sessions[e.session] = true
    end
  end
  if count ~= #decoded or (cleanups > 0 and count ~= 1) then return 0 end
  entries = decoded
end
local clock = redis.call('TIME')
local now = tonumber(clock[1]) * 1000 + math.floor(tonumber(clock[2]) / 1000)
local live = {}
local found = false
local maxExpiry = 0
for _, e in ipairs(entries) do
  if e.expires > now then
    if e.token == ARGV[2] then found = true end
    table.insert(live, e)
  end
end
local result = 0
if ARGV[1] == 'acquire' then
  local busy = #live >= tonumber(ARGV[4])
  for _, e in ipairs(live) do
    if e.cleanup or ARGV[6] == 'true' or e.session == ARGV[3] then busy = true end
  end
  if not busy then
    table.insert(live, {token=ARGV[2], session=ARGV[3], expires=now + tonumber(ARGV[5]), cleanup=ARGV[6] == 'true'})
    result = 1
  end
elseif found then
  result = 1
  for i = #live, 1, -1 do
    if live[i].token == ARGV[2] then
      if ARGV[1] == 'renew' then
        live[i].expires = now + tonumber(ARGV[5])
      elseif ARGV[1] == 'release' then
        table.remove(live, i)
      end
    end
  end
end
if #live == 0 then
  redis.call('DEL', KEYS[1])
else
  for _, e in ipairs(live) do maxExpiry = math.max(maxExpiry, e.expires) end
  redis.call('SET', KEYS[1], prefix .. cjson.encode(live), 'PX', math.max(1, maxExpiry - now))
end
return result
`)

func (g *Gates) TryAcquireArchive(ctx context.Context, owner, session string, limit int, cleanup bool) (io.Closer, error) {
	key, err := filestorage.ArchiveGateKey(owner, session, limit, cleanup)
	if err != nil {
		return nil, err
	}
	if err := context.Cause(ctx); err != nil {
		return nil, err
	}
	key = residencyKey(key)
	token := rand.Text()
	started := time.Now()
	acquired, err := archiveGate.Run(ctx, g.client, []string{key}, "acquire", token, session, limit, g.ttl.Milliseconds(), strconv.FormatBool(cleanup)).Int()
	if err != nil {
		// A lost response may have granted a lease; expiry bounds that grant.
		return nil, fmt.Errorf("acquire Redis archive gate: %w", err)
	}
	if acquired != 1 {
		if err := context.Cause(ctx); err != nil {
			return nil, err
		}
		return nil, filestorage.ErrGateBusy
	}
	permit := g.newLease(key, token, started.Add(g.ttl), true)
	if err := errors.Join(context.Cause(ctx), permit.check()); err != nil {
		return nil, errors.Join(err, permit.Close())
	}
	return permit, nil
}
