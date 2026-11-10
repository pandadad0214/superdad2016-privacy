/**
 * Panda Federation WebMCP helper.
 *
 * Registers read-only tools with document.modelContext when the browser
 * (or a scanner polyfill) exposes the WebMCP API. Safe to include on any
 * public page: feature-detected, no-ops in ordinary browsers, never throws
 * into the console as an unhandled rejection.
 *
 * Current API (W3C Web Machine Learning CG draft, Chrome origin trial):
 *   await document.modelContext.registerTool({
 *     name, title, description, inputSchema, outputSchema, execute, annotations
 *   }, { signal })
 *
 * navigator.modelContext / provideContext / unregisterTool were removed or
 * deprecated. This script only registers on document.modelContext.
 *
 * Declarative <form toolname> markup (removed from the spec in October 2026
 * but still scored by some scanners) is injected as visually hidden forms.
 *
 * Boot: <script src="panda-webmcp.js" defer
 *          data-webmcp-catalog="webmcp-catalog.json"
 *          data-webmcp-scope="site"></script>
 *
 * Scopes: site | pft | qft | hidden-ai | privacy
 */
(function (global) {
  "use strict";

  var READ_ONLY = { readOnlyHint: true, consequentialHint: false, untrustedContentHint: false, debugging: false };
  var CLIENTS = ["uvx", "cursor", "claude-desktop", "claude-code", "vscode", "gemini-cli"];
  var started = false;
  var registered = false;
  var thisScript = document.currentScript;

  function modelContext() {
    try {
      if (typeof document !== "undefined" && document.modelContext && typeof document.modelContext.registerTool === "function") {
        return document.modelContext;
      }
    } catch (err) {}
    return null;
  }

  function text(value) {
    if (value == null) return "";
    return String(value).replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").trim();
  }

  function norm(value) {
    return text(value).toLowerCase();
  }

  function matches(hay, query) {
    if (!query) return true;
    var q = norm(query);
    if (!q) return true;
    if (typeof hay === "string") return norm(hay).indexOf(q) !== -1;
    if (Array.isArray(hay)) {
      for (var i = 0; i < hay.length; i++) if (matches(hay[i], query)) return true;
      return false;
    }
    if (hay && typeof hay === "object") {
      for (var key in hay) if (Object.prototype.hasOwnProperty.call(hay, key) && matches(hay[key], query)) return true;
    }
    return false;
  }

  function allTools(catalog) {
    var out = [];
    var servers = (catalog && catalog.servers) || [];
    for (var i = 0; i < servers.length; i++) {
      var server = servers[i];
      var tools = server.tools || [];
      for (var j = 0; j < tools.length; j++) {
        var tool = tools[j];
        out.push({
          name: tool.name,
          title: text(tool.title || tool.name),
          description: text(tool.description || tool.title || ""),
          server: server.id,
          server_name: server.name,
          apify: tool.apify || null,
          url: tool.url || tool.apify || null
        });
      }
    }
    return out;
  }

  function findServer(catalog, id) {
    if (!id) return null;
    var wanted = norm(id);
    var servers = (catalog && catalog.servers) || [];
    for (var i = 0; i < servers.length; i++) {
      var server = servers[i];
      if (norm(server.id) === wanted || norm(server.name) === wanted || norm(server.command) === wanted) return server;
    }
    return null;
  }

  function publicServer(server) {
    if (!server) return null;
    return {
      id: server.id,
      name: server.name,
      tool_count: (typeof server.tool_count === "number") ? server.tool_count : ((server.tools || []).length),
      description: text(server.description),
      repo: server.repo || null,
      pypi: server.pypi || null,
      pypi_version: server.pypi_version || null,
      homepage: server.homepage || null,
      registry: server.registry || null,
      install_uvx: server.install && server.install.uvx ? server.install.uvx : null,
      requires: (server.install && server.install.requires) || [],
      related: server.related || [],
      listings: server.listings || {}
    };
  }

  function installCommand(server, client) {
    if (!server) {
      return { error: "Unknown server. Call list_servers to see ids.", servers: null };
    }
    var chosen = client || "uvx";
    if (CLIENTS.indexOf(chosen) === -1) {
      return { error: "Unsupported client.", clients: CLIENTS };
    }
    var uvx = (server.install && server.install.uvx) || null;
    var requires = (server.install && server.install.requires) || [];
    var env = {};
    for (var i = 0; i < requires.length; i++) env[requires[i]] = "${" + requires[i] + "}";
    var config = {
      mcpServers: {}
    };
    var entry = { command: "uvx", args: (server.install && server.install.args) || [] };
    if (requires.length) entry.env = env;
    config.mcpServers[server.id] = entry;
    var command = uvx;
    if (chosen === "claude-code" && uvx) {
      command = "claude mcp add --transport stdio " + server.id + " -- " + uvx;
    } else if (chosen === "gemini-cli" && uvx) {
      command = "gemini mcp add " + server.id + " -- " + uvx;
    }
    return {
      server: server.id,
      client: chosen,
      command: command,
      mcp_config: config,
      requires: requires,
      notes: server.install && server.install.notes ? server.install.notes : null,
      docs: server.homepage || server.repo || null
    };
  }

  function siteLinks(catalog) {
    var site = (catalog && catalog.site) || {};
    var links = site.links || {};
    return {
      site: site.url || null,
      github: links.github || "https://github.com/pandadad0214",
      pypi: links.pypi || "https://pypi.org/org/pandadad0214/",
      mcp_registry: links.mcp_registry || "https://registry.modelcontextprotocol.io/v0/servers?search=io.github.pandadad0214",
      apify: links.apify || "https://apify.com/pandadad0214",
      product_hunt: links.product_hunt || "https://www.producthunt.com/products/panda-federation-tools",
      official_site: links.official_site || "https://pandafederation.com/",
      tools_docs: links.tools_docs || "https://pandadad0214.github.io/panda-federation-tools/",
      x: links.x || "https://x.com/PandaFedHQ",
      llms_txt: links.llms_txt || null,
      catalog: links.catalog || null,
      more: links.more || {}
    };
  }

  function buildTools(catalog, scope) {
    var tools = [];
    var serversPublic = function () {
      return ((catalog && catalog.servers) || []).map(publicServer);
    };

    function add(tool) {
      tools.push(tool);
    }

    if (scope === "site" || scope === "pft" || scope === "qft") {
      add({
        name: "list_servers",
        title: "List MCP servers",
        description: "List Panda Federation MCP servers with official tool counts, descriptions, install commands and directory links. Use this first to see what is available.",
        inputSchema: { type: "object", properties: {}, additionalProperties: false },
        execute: function () {
          var list = serversPublic();
          var total = list.reduce(function (n, s) {
            if (s.id === "panda-federation-tools") return n;
            return n + (s.tool_count || 0);
          }, 0);
          return { count: list.length, total_tools: total, servers: list };
        },
        annotations: READ_ONLY
      });
    }

    if (scope !== "privacy") {
      add({
        name: "list_tools",
        title: "List tools",
        description: "List catalog tools with their server, short description and Store or repo link. Optionally filter to one server id from list_servers.",
        inputSchema: {
          type: "object",
          properties: {
            server: { type: "string", description: "Optional server id, for example panda-research-tools." }
          },
          additionalProperties: false
        },
        execute: function (input) {
          input = input || {};
          var list = allTools(catalog);
          var serverId = text(input.server);
          if (serverId) {
            var server = findServer(catalog, serverId);
            if (!server) {
              return { error: "Unknown server id.", servers: ((catalog && catalog.servers) || []).map(function (s) { return s.id; }) };
            }
            list = list.filter(function (t) { return t.server === server.id; });
          }
          return { count: list.length, server: serverId || null, tools: list };
        },
        annotations: READ_ONLY
      });
    }

    if (scope === "site" || scope === "pft") {
      add({
        name: "search_tools",
        title: "Search tools",
        description: "Search MCP tools and servers by keyword. Matches names, titles, descriptions and server ids from the page catalog.",
        inputSchema: {
          type: "object",
          properties: {
            query: { type: "string", description: "Words to search for, for example grants, citations, or Colorado." }
          },
          required: ["query"],
          additionalProperties: false
        },
        execute: function (input) {
          input = input || {};
          var query = text(input.query);
          if (!query) return { error: "Pass a query string.", hint: "Example: citations, SAM.gov, or RSS." };
          var toolsFound = allTools(catalog).filter(function (t) { return matches(t, query); });
          var serversFound = ((catalog && catalog.servers) || []).filter(function (s) { return matches(s, query); }).map(publicServer);
          return { query: query, tool_count: toolsFound.length, tools: toolsFound, servers: serversFound };
        },
        annotations: READ_ONLY
      });
    }

    if (scope === "site" || scope === "pft" || scope === "qft") {
      add({
        name: "get_install_command",
        title: "Get install command",
        description: "Return the uvx command and an MCP client config snippet for a server. Does not install anything; it only reads the catalog.",
        inputSchema: {
          type: "object",
          properties: {
            server: { type: "string", description: "Server id from list_servers, for example panda-leads-tools." },
            client: { type: "string", enum: CLIENTS, default: "uvx", description: "Which client config to format." }
          },
          required: ["server"],
          additionalProperties: false
        },
        execute: function (input) {
          input = input || {};
          var server = findServer(catalog, text(input.server));
          if (!server) {
            return { error: "Unknown server id.", servers: ((catalog && catalog.servers) || []).map(function (s) { return s.id; }), clients: CLIENTS };
          }
          return installCommand(server, text(input.client) || "uvx");
        },
        annotations: READ_ONLY
      });
    }

    add({
      name: "get_links",
      title: "Get official links",
      description: "Return official links for this project: website, GitHub, PyPI, MCP Registry, Apify Store, Product Hunt and llms.txt, when they apply.",
      inputSchema: { type: "object", properties: {}, additionalProperties: false },
      execute: function () {
        var links = siteLinks(catalog);
        if (catalog && catalog.page_links) {
          for (var key in catalog.page_links) {
            if (Object.prototype.hasOwnProperty.call(catalog.page_links, key)) links[key] = catalog.page_links[key];
          }
        }
        return links;
      },
      annotations: READ_ONLY
    });

    if (scope === "site") {
      add({
        name: "list_actors",
        title: "List Apify Actors",
        description: "List public Apify Store Actors from Panda Federation, with title, family, short description and Store URL. Optionally filter by keyword.",
        inputSchema: {
          type: "object",
          properties: {
            query: { type: "string", description: "Optional keyword to filter Actors, for example permits or WHOIS." }
          },
          additionalProperties: false
        },
        execute: function (input) {
          input = input || {};
          var query = text(input.query);
          var actors = ((catalog && catalog.actors) || []).filter(function (a) { return matches(a, query); });
          return { count: actors.length, query: query || null, actors: actors };
        },
        annotations: READ_ONLY
      });
      add({
        name: "list_apps",
        title: "List apps and repos",
        description: "List Panda Federation apps and companion repos, including local-first shell tools and product pages.",
        inputSchema: { type: "object", properties: {}, additionalProperties: false },
        execute: function () {
          var apps = (catalog && catalog.apps) || [];
          return { count: apps.length, apps: apps };
        },
        annotations: READ_ONLY
      });
    }

    if (scope === "site" || scope === "qft" || scope === "pft") {
      if (catalog && catalog.editions && catalog.editions.length) {
        add({
          name: "list_editions",
          title: "List free and paid editions",
          description: "List free and paid editions of related products and how to switch between them. Read-only; it does not purchase or sign anything up.",
          inputSchema: { type: "object", properties: {}, additionalProperties: false },
          execute: function () {
            return { count: catalog.editions.length, editions: catalog.editions };
          },
          annotations: READ_ONLY
        });
      }
    }

    if (scope === "hidden-ai") {
      add({
        name: "get_project_overview",
        title: "Get project overview",
        description: "Return a short overview of Hidden AI Instructions Watch: the free scanner and the public evidence log, with links.",
        inputSchema: { type: "object", properties: {}, additionalProperties: false },
        execute: function () {
          return (catalog && catalog.overview) || { error: "Overview not in catalog." };
        },
        annotations: READ_ONLY
      });
    }

    if (scope === "privacy") {
      add({
        name: "get_privacy_policy",
        title: "Get privacy policy",
        description: "Return the privacy policy text published on this page, including the last-updated date.",
        inputSchema: { type: "object", properties: {}, additionalProperties: false },
        execute: function () {
          return (catalog && catalog.policy) || { error: "Policy not in catalog." };
        },
        annotations: READ_ONLY
      });
    }

    return tools;
  }

  function describeForm(tool) {
    var props = (tool.inputSchema && tool.inputSchema.properties) || {};
    var required = (tool.inputSchema && tool.inputSchema.required) || [];
    var html = "<form toolname=\"" + tool.name + "\" tooldescription=\"" + escapeAttr(tool.description) + "\" toolautosubmit=\"true\">";
    Object.keys(props).forEach(function (name) {
      var prop = props[name] || {};
      var req = required.indexOf(name) !== -1 ? " required" : "";
      html += "<label>" + escapeHtml(name) +
        "<input name=\"" + escapeAttr(name) + "\" type=\"text\" toolparamdescription=\"" +
        escapeAttr(prop.description || name) + "\"" + req + "></label>";
    });
    html += "</form>";
    return html;
  }

  function escapeAttr(value) {
    return text(value).replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;");
  }

  function escapeHtml(value) {
    return text(value).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  }

  function injectForms(tools) {
    if (document.querySelector("form[toolname]")) return;
    if (!document.body) return;
    var section = document.createElement("section");
    section.className = "webmcp-tools";
    section.setAttribute("aria-hidden", "true");
    section.innerHTML = tools.map(describeForm).join("");
    if (!document.getElementById("webmcp-visually-hidden-style")) {
      var style = document.createElement("style");
      style.id = "webmcp-visually-hidden-style";
      style.textContent = ".webmcp-tools{position:absolute;width:1px;height:1px;padding:0;margin:-1px;overflow:hidden;clip:rect(0,0,0,0);white-space:nowrap;border:0;}";
      document.head.appendChild(style);
    }
    document.body.appendChild(section);
  }

  function catchRegister(promise) {
    if (promise && typeof promise.then === "function") {
      return promise.then(function () {}, function () {});
    }
    return Promise.resolve();
  }

  function registerAll(tools) {
    var mc = modelContext();
    if (!mc) return Promise.resolve(false);
    var chain = Promise.resolve();
    tools.forEach(function (tool) {
      chain = chain.then(function () {
        try {
          return catchRegister(mc.registerTool(tool));
        } catch (err) {
          return Promise.resolve();
        }
      });
    });
    return chain.then(function () {
      registered = true;
      return true;
    });
  }

  function fetchCatalog(url) {
    return fetch(url, { credentials: "same-origin" }).then(function (res) {
      if (!res.ok) throw new Error("catalog " + res.status);
      return res.json();
    });
  }

  function boot(catalog, scope) {
    var tools = buildTools(catalog, scope || "site");
    injectForms(tools);
    function attempt() {
      if (registered) return Promise.resolve(true);
      return registerAll(tools);
    }
    attempt();
    if (document.readyState === "loading") {
      document.addEventListener("DOMContentLoaded", function () { attempt(); injectForms(tools); });
    }
    global.addEventListener("load", function () { attempt(); });
    var tries = 0;
    var timer = global.setInterval(function () {
      tries += 1;
      attempt().then(function (ok) {
        if (ok || tries >= 20) global.clearInterval(timer);
      });
    }, 250);
    return tools;
  }

  function start() {
    if (started) return;
    started = true;
    var script = thisScript;
    if (!script) {
      var scripts = document.getElementsByTagName("script");
      for (var i = scripts.length - 1; i >= 0; i--) {
        if (scripts[i].getAttribute("data-webmcp-catalog") || /panda-webmcp\.js/.test(scripts[i].src || "")) {
          script = scripts[i];
          break;
        }
      }
    }
    var catalogUrl = script && script.getAttribute("data-webmcp-catalog");
    var scope = (script && script.getAttribute("data-webmcp-scope")) || "site";
    var embedded = document.getElementById("webmcp-catalog");
    var ready;
    if (embedded && embedded.textContent) {
      try {
        ready = Promise.resolve(JSON.parse(embedded.textContent));
      } catch (err) {
        ready = Promise.reject(err);
      }
    } else if (catalogUrl) {
      ready = fetchCatalog(catalogUrl);
    } else {
      return;
    }
    ready.then(function (catalog) {
      boot(catalog, scope);
    }).catch(function () {
      // Catalog failed to load. Leave the page unchanged and do not throw.
    });
  }

  global.PandaWebMCP = {
    modelContext: modelContext,
    buildTools: buildTools,
    boot: boot,
    start: start
  };

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", start);
  } else {
    start();
  }
})(window);
