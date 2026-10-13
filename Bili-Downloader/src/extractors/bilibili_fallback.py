import json
import re
import time
import urllib.parse
import urllib.request

from src.extractors.base import BilibiliExtractor, ExtractOptions, ExtractorError
from src.extractors.wbi import sign
from src.auth.cookies import build_cookie_header, read_netscape
from src.models.format_info import FormatInfo, format_info_from_dict
from src.models.video_info import PageInfo, SubtitleInfo, VideoInfo

API = "https://api.bilibili.com"
HEADERS = {"User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)",
           "Referer": "https://www.bilibili.com/"}

_BVID_RE = re.compile(r"(BV[0-9A-Za-z]{10})")


class BilibiliFallbackExtractor(BilibiliExtractor):
    def is_available(self) -> bool:
        return True

    def extract(self, url: str, opts: ExtractOptions) -> list[VideoInfo]:
        bvid = self._bvid(url)
        if not bvid:
            raise ExtractorError("Invalid Bilibili URL.")
        wbi = self._get_wbi_keys(opts)
        view = self._get_json(f"/x/web-interface/view?bvid={bvid}", opts)
        if view.get("code") != 0:
            raise ExtractorError(self._code_message(view.get("code")))
        data = view["data"]
        pages = [
            PageInfo(index=int(p.get("page") or i + 1),
                     title=p.get("part") or data.get("title", ""),
                     cid=int(p.get("cid") or 0),
                     duration=float(p.get("duration") or 0.0),
                     url=url)
            for i, p in enumerate(data.get("pages") or [])
        ]
        cid = pages[0].cid if pages else 0

        playurl = self._get_signed(
            f"/x/player/playurl?bvid={bvid}&cid={cid}&fnval=4048&fourk=1",
            wbi, opts)
        video_fmts, audio_fmts = self._parse_playurl(playurl)

        subs: list[SubtitleInfo] = []
        try:
            v2 = self._get_json(f"/x/player/v2?bvid={bvid}&cid={cid}", opts)
            for s in (v2.get("data", {}).get("subtitle", {}).get("subtitles") or []):
                subs.append(SubtitleInfo(lang=s.get("lan", ""), url=s.get("subtitle_url", "")))
        except ExtractorError:
            pass

        return [VideoInfo(
            url=url, bvid=bvid, title=data.get("title", ""),
            uploader=data.get("owner", {}).get("name", ""),
            duration=float(data.get("duration") or 0.0),
            thumbnail_url=data.get("pic", ""),
            view_count=int((data.get("stat") or {}).get("view") or 0),
            upload_date=self._upload_date(data.get("pubdate")),
            pages=pages, video_formats=video_fmts, audio_formats=audio_fmts,
            subtitles=subs, extractor="bilibili-web",
        )]

    # --- helpers ---
    def _upload_date(self, pubdate) -> str:
        """Unix timestamp -> the YYYYMMDD form yt-dlp reports."""
        if not pubdate:
            return ""
        return time.strftime("%Y%m%d", time.localtime(int(pubdate)))

    def _bvid(self, url: str) -> str | None:
        m = _BVID_RE.search(url)
        return m.group(1) if m else None

    def _get_wbi_keys(self, opts: ExtractOptions) -> tuple[str, str]:
        nav = self._get_json("/x/web-interface/nav", opts)
        wbi = nav.get("data", {}).get("wbi_img", {})
        img = self._key_from_url(wbi.get("img_url", ""))
        sub = self._key_from_url(wbi.get("sub_url", ""))
        if not img or not sub:
            raise ExtractorError("Could not obtain WBI keys.")
        return img, sub

    def _key_from_url(self, url: str) -> str:
        m = re.search(r"/([A-Za-z0-9]+)\.(?:png|jpg)", url)
        return m.group(1) if m else ""

    def _get_json(self, path: str, opts: ExtractOptions) -> dict:
        req = urllib.request.Request(API + path, headers=self._headers(opts))
        with urllib.request.urlopen(req, timeout=15) as r:
            return json.loads(r.read().decode("utf-8"))

    def _get_signed(self, path: str, wbi, opts: ExtractOptions) -> dict:
        parsed = urllib.parse.urlparse(path)
        qs = dict(urllib.parse.parse_qsl(parsed.query))
        signed = sign(qs, wbi[0], wbi[1], int(time.time()))
        query = urllib.parse.urlencode(signed)
        return self._get_json(f"{parsed.path}?{query}", opts)

    def _headers(self, opts: ExtractOptions) -> dict:
        h = dict(HEADERS)
        if opts.cookies_file:
            h["Cookie"] = self._cookie_header(opts.cookies_file)
        return h

    def _cookie_header(self, cookies_file: str) -> str:
        return build_cookie_header(read_netscape(cookies_file))

    def _parse_playurl(self, playurl: dict) -> tuple[list[FormatInfo], list[FormatInfo]]:
        dash = (playurl.get("data") or {}).get("dash") or {}
        video = [self._dash_fmt(f, "video") for f in dash.get("video") or []]
        audio = [self._dash_fmt(f, "audio") for f in dash.get("audio") or []]
        for f in (dash.get("dolby") or {}).get("audio") or []:
            audio.append(self._dash_fmt(f, "audio", note="Dolby Audio"))
        for f in (dash.get("flac") or {}).get("audio") or []:
            audio.append(self._dash_fmt(f, "audio", note="Hi-Res"))
        return video, audio

    def _dash_fmt(self, f: dict, kind: str, note: str = "") -> FormatInfo:
        d = {
            "format_id": str(f.get("id", "")),
            "ext": "m4s",
            "width": f.get("width"), "height": f.get("height"),
            "vcodec": "none" if kind == "audio" else f.get("codecs"),
            "acodec": f.get("codecs") if kind == "audio" else "none",
            "quality": f.get("id"),
            "abr": f.get("bandwidth") if kind == "audio" else None,
            "vbr": f.get("bandwidth") if kind == "video" else None,
            "asr": f.get("sample_rate"),
        }
        fi = format_info_from_dict(d)
        if note:
            fi = FormatInfo(**{**fi.__dict__, "audio_note": note})
        return fi

    def _code_message(self, code: int) -> str:
        return {
            -404: "Video not found or deleted.",
            -403: "This video is private.",
            -101: "Login required. Provide cookies.",
            -10403: "Not available in your region.",
        }.get(code, f"Bilibili API error code {code}.")
