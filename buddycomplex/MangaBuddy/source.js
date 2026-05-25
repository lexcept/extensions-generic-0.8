"use strict";
var _Sources = (() => {
  var BASE_DOMAIN = "https://mangak.io";
  var API_DOMAIN = "https://api.mangak.io";

  var ContentRating = {
    EVERYONE: "EVERYONE",
    MATURE: "MATURE",
    ADULT: "ADULT"
  };

  var SourceIntents = {
    MANGA_CHAPTERS: 1,
    MANGA_TRACKING: 2,
    HOMEPAGE_SECTIONS: 4,
    COLLECTION_MANAGEMENT: 8,
    CLOUDFLARE_BYPASS_REQUIRED: 16,
    SETTINGS_UI: 32
  };

  var HomeSectionType = {
    singleRowNormal: "singleRowNormal",
    singleRowLarge: "singleRowLarge",
    doubleRow: "doubleRow",
    featured: "featured"
  };

  var MangaBuddyInfo = {
    version: "3.1.0",
    name: "Mangak",
    description: "Extension that pulls manga from " + BASE_DOMAIN + " (formerly mangabuddy.com)",
    author: "Netsky",
    authorWebsite: "http://github.com/TheNetsky",
    icon: "icon.png",
    contentRating: ContentRating.MATURE,
    websiteBaseURL: BASE_DOMAIN,
    sourceTags: [],
    intents: SourceIntents.MANGA_CHAPTERS | SourceIntents.HOMEPAGE_SECTIONS
  };

  class MangaBuddy {
    constructor(cheerio) {
      this.cheerio = cheerio;
      this.requestManager = App.createRequestManager({
        requestsPerSecond: 4,
        requestTimeout: 15000,
        interceptor: {
          interceptRequest: async (request) => {
            request.headers = Object.assign({}, request.headers || {}, {
              "user-agent": await this.requestManager.getDefaultUserAgent(),
              "accept": "application/json, text/plain, */*",
              "origin": BASE_DOMAIN,
              "referer": BASE_DOMAIN + "/"
            });
            return request;
          },
          interceptResponse: async (response) => response
        }
      });
    }

    getMangaShareUrl(mangaId) {
      return BASE_DOMAIN + "/" + mangaId;
    }

    async getMangaDetails(mangaId) {
      const detail = await this.fetchTitleDetailBySlug(mangaId);

      const titles = [detail.name];
      const alt = detail.alt_name;
      if (typeof alt === "string" && alt.trim().length > 0) {
        for (const t of alt.split(/[;,\/|]/)) {
          const trimmed = t.trim();
          if (trimmed) titles.push(trimmed);
        }
      } else if (Array.isArray(alt)) {
        for (const entry of alt) {
          if (!entry) continue;
          for (const t of String(entry).split(/[;,\/|]/)) {
            const trimmed = t.trim();
            if (trimmed) titles.push(trimmed);
          }
        }
      }

      const authors = (detail.authors || []).map((a) => a.name).join(", ") || "Unknown";
      const artists = (detail.artists || []).map((a) => a.name).join(", ") || authors;

      const genreTags = (detail.genres || []).map((g) =>
        App.createTag({ id: "genres:" + g.slug, label: g.name })
      );
      const extraTags = (detail.tags || []).map((t) =>
        App.createTag({ id: "tags:" + t.slug, label: t.name })
      );

      const tagSections = [];
      if (genreTags.length > 0) {
        tagSections.push(App.createTagSection({ id: "0", label: "Genres", tags: genreTags }));
      }
      if (extraTags.length > 0) {
        tagSections.push(App.createTagSection({ id: "1", label: "Tags", tags: extraTags }));
      }

      return App.createSourceManga({
        id: mangaId,
        mangaInfo: App.createMangaInfo({
          titles,
          image: detail.cover || "",
          status: this.normaliseStatus(detail.status),
          author: authors,
          artist: artists,
          tags: tagSections,
          desc: detail.summary || ""
        })
      });
    }

    async getChapters(mangaId) {
      const titleSqid = await this.resolveSlugToSqid(mangaId);
      const payload = await this.apiGet("/titles/" + titleSqid + "/chapters");
      const raw = payload.data;
      const rawChapters = Array.isArray(raw) ? raw : (raw && (raw.items || raw.chapters)) || [];
      if (rawChapters.length === 0) {
        throw new Error("No chapters found for " + mangaId);
      }

      const built = rawChapters.map((r) => {
        const chapNum = this.extractChapterNumber(r);
        const time = r.updated_at ? new Date(r.updated_at) : new Date(r.cv || Date.now());
        return {
          id: r.slug || r.id,
          name: r.name,
          chapNum,
          time
        };
      });

      built.sort((a, b) => a.chapNum - b.chapNum);
      return built.map((c, idx) =>
        App.createChapter({
          id: c.id,
          name: c.name,
          chapNum: c.chapNum,
          time: c.time,
          volume: 0,
          sortingIndex: idx,
          langCode: "\u{1F1EC}\u{1F1E7}",
          group: ""
        })
      );
    }

    async getChapterDetails(mangaId, chapterId) {
      const resolved = await this.resolveChapter(mangaId, chapterId);
      const payload = await this.apiGet("/titles/" + resolved.titleSqid + "/chapters/" + resolved.chapterSqid);
      const pages = (payload.data && payload.data.chapter && payload.data.chapter.images) || [];
      if (pages.length === 0) {
        throw new Error("No pages for chapter " + chapterId);
      }
      return App.createChapterDetails({
        id: chapterId,
        mangaId,
        pages
      });
    }

    async resolveChapter(mangaSlug, chapterId) {
      // Backward-compatible: v2.0.4 stored chapterId as the chapter slug (e.g. "chapter-161").
      // v3 API needs both title sqid and chapter sqid. The /titles/by-slug/.../chapters/...
      // endpoint resolves both in a single round trip.
      if (/^[A-Za-z0-9]+$/.test(chapterId) && chapterId.length <= 10 && !/^chapter/i.test(chapterId)) {
        // Already looks like a sqid (purely alphanumeric, short). Resolve only the title.
        const titleSqid = await this.resolveSlugToSqid(mangaSlug);
        return { titleSqid, chapterSqid: chapterId };
      }
      const payload = await this.apiGet(
        "/titles/by-slug/" + encodeURIComponent(mangaSlug) + "/chapters/" + encodeURIComponent(chapterId)
      );
      const newUrl = (payload.data && payload.data.new_url) || "";
      const m = newUrl.match(/^\/titles\/([A-Za-z0-9]+)(?:-[^/]*)?\/([A-Za-z0-9]+)/);
      if (!m) throw new Error('Could not resolve chapter "' + chapterId + '" for ' + mangaSlug);
      return { titleSqid: m[1], chapterSqid: m[2] };
    }

    async getSearchTags() {
      const payload = await this.apiGet("/genres");
      const items = (payload.data && payload.data.items) || [];
      const tags = items.map((g) => App.createTag({ id: "genres:" + g.slug, label: g.name }));
      return [App.createTagSection({ id: "0", label: "Genres", tags })];
    }

    async getSearchResults(query, metadata) {
      const page = (metadata && metadata.page) || 1;
      const params = ["page=" + page, "limit=20"];

      const title = ((query && query.title) || "").trim();
      if (title.length > 0) params.push("q=" + encodeURIComponent(title));

      const genreSlugs = ((query && query.includedTags) || [])
        .map((t) => t.id)
        .filter((id) => typeof id === "string" && id.indexOf("genres:") === 0)
        .map((id) => id.slice("genres:".length));
      if (genreSlugs.length > 0) {
        params.push("genres=" + encodeURIComponent(genreSlugs.join(",")));
      }

      const payload = await this.apiGet("/titles/search?" + params.join("&"));
      const items = (payload.data && payload.data.items) || [];
      const results = items.map((item) => this.itemToPartialManga(item));
      const pagination = (payload.data && payload.data.pagination) || {};
      const hasNext = pagination.has_next != null ? pagination.has_next : results.length >= 20;
      return App.createPagedResults({
        results,
        metadata: hasNext ? { page: page + 1 } : undefined
      });
    }

    async getHomePageSections(sectionCallback) {
      const sections = [
        { id: "top_update", title: "Latest Updates", path: "/trending/top-update?limit=20" },
        { id: "rising", title: "Rising", path: "/trending/rising?limit=20" },
        { id: "top_titles", title: "Trending", path: "/trending/titles?limit=20" }
      ];

      await Promise.all(
        sections.map(async (meta) => {
          try {
            const payload = await this.apiGet(meta.path);
            const raw = payload.data;
            const items = Array.isArray(raw) ? raw : (raw && raw.items) || [];
            sectionCallback(
              App.createHomeSection({
                id: meta.id,
                title: meta.title,
                type: HomeSectionType.singleRowNormal,
                containsMoreItems: true,
                items: items.map((i) => this.itemToPartialManga(i))
              })
            );
          } catch (e) {
            sectionCallback(
              App.createHomeSection({
                id: meta.id,
                title: meta.title,
                type: HomeSectionType.singleRowNormal,
                containsMoreItems: false,
                items: []
              })
            );
          }
        })
      );
    }

    async getViewMoreItems(homepageSectionId, metadata) {
      const page = (metadata && metadata.page) || 1;
      const limit = 20;
      const offset = (page - 1) * limit;

      const pathByKey = {
        top_update: "/trending/top-update?limit=" + limit + "&offset=" + offset,
        rising: "/trending/rising?limit=" + limit + "&offset=" + offset,
        top_titles: "/trending/titles?limit=" + limit + "&offset=" + offset
      };
      const path = pathByKey[homepageSectionId];
      if (!path) throw new Error("Unknown homepage section: " + homepageSectionId);

      const payload = await this.apiGet(path);
      const raw = payload.data;
      const items = Array.isArray(raw) ? raw : (raw && raw.items) || [];
      const results = items.map((i) => this.itemToPartialManga(i));
      return App.createPagedResults({
        results,
        metadata: results.length >= limit ? { page: page + 1 } : undefined
      });
    }

    itemToPartialManga(item) {
      const latest = item.latest_chapters && item.latest_chapters[0];
      const subtitle = (latest && latest.name) || "";
      return App.createPartialSourceManga({
        mangaId: item.slug,
        image: item.cover || "",
        title: item.name || item.slug || "",
        subtitle
      });
    }

    async fetchTitleDetailBySlug(slug) {
      const sqid = await this.resolveSlugToSqid(slug);
      const payload = await this.apiGet("/titles/" + sqid);
      return (payload.data && payload.data.title) || {};
    }

    async resolveSlugToSqid(slug) {
      const payload = await this.apiGet("/titles/by-slug/" + encodeURIComponent(slug));
      const newUrl = (payload.data && payload.data.new_url) || "";
      const match = newUrl.match(/^\/titles\/([A-Za-z0-9]+)/);
      if (!match) throw new Error('Could not resolve slug "' + slug + '" to a title id');
      return match[1];
    }

    async apiGet(path) {
      const request = App.createRequest({
        url: API_DOMAIN + path,
        method: "GET"
      });
      const response = await this.requestManager.schedule(request, 1);
      if (response.status < 200 || response.status >= 300) {
        throw new Error("API " + path + " returned HTTP " + response.status);
      }
      const body = typeof response.data === "string" ? response.data : String(response.data);
      return JSON.parse(body);
    }

    normaliseStatus(raw) {
      switch (String(raw || "").toLowerCase()) {
        case "completed":
          return "Completed";
        case "hiatus":
          return "Hiatus";
        case "cancelled":
        case "canceled":
          return "Cancelled";
        default:
          return "Ongoing";
      }
    }

    extractChapterNumber(raw) {
      const candidates = [raw.slug, raw.name];
      for (const text of candidates) {
        if (!text) continue;
        const m = String(text).match(/chapter[\s_-]*(\d+(?:[.-]\d+)?)/i);
        if (m && m[1]) {
          const n = Number(m[1].replace("-", "."));
          if (!isNaN(n)) return n;
        }
      }
      const tail = (raw.slug || "").split("-").pop() || "";
      const numMatch = tail.match(/(\d+(?:\.\d+)?)/);
      if (numMatch && numMatch[1]) {
        const n = Number(numMatch[1]);
        if (!isNaN(n)) return n;
      }
      return raw.chapter_number || 0;
    }
  }

  return { MangaBuddy, MangaBuddyInfo };
})();
this.Sources = _Sources; if (typeof exports === 'object' && typeof module !== 'undefined') {module.exports.Sources = this.Sources;}
