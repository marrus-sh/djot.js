import { Event } from "./event.js";
import { AttributeParser } from "./attributes.js";
import { pattern, find, boundedFind } from "./find.js";

// General note on the parsing strategy:  our objective is to
// parse without backtracking. To that end, we keep a stack of
// potential 'openers' for links, images, emphasis, and other
// inline containers.  When we parse a potential closer for
// one of these constructions, we can scan the stack of openers
// for a match, which will tell us the location of the potential
// opener. We can then change the annotation of the match at
// that location to '+emphasis' or whatever.

// Opener:
// 1 = startpos, 2 = endpos, 3 = annotation, 4 = substartpos, 5 = endpos
//
// [link text](url)
// ^         ^^
// 1         23
// startpos    (1)
// endpos      (1)
// substartpos (2)
// subendpos   (3)
// annot       "explicit_link"

type Opener = {
  startpos : number,
  endpos : number,
  annot : null | string,
  substartpos : null | number,
  subendpos : null | number
}

type OpenerMap =
  { [opener: string]: Opener[] } // in reverse order

const C_TAB = 9;
const C_LF = 10;
const C_CR = 13;
const C_SPACE = 32;
const C_DOUBLE_QUOTE = 34;
const C_SINGLE_QUOTE = 39;
const C_LEFT_PAREN = 40;
const C_RIGHT_PAREN = 41;
const C_ASTERISK = 42;
const C_PLUS = 43;
const C_HYPHEN = 45;
const C_PERIOD = 46;
const C_COLON = 58;
const C_LESSTHAN = 60;
const C_EQUALS = 61;
const C_LEFT_BRACKET = 91;
const C_BACKSLASH = 92;
const C_RIGHT_BRACKET = 93;
const C_HAT = 94;
const C_UNDERSCORE = 95;
const C_BACKTICK = 96;
const C_LEFT_BRACE = 123;
const C_RIGHT_BRACE = 125;
const C_TILDE = 126;

const isSpecial = function(cp : number) {
  return (cp === C_LF ||
          cp === C_CR ||
          cp === C_DOUBLE_QUOTE ||
          cp === C_SINGLE_QUOTE ||
          cp === C_LEFT_PAREN ||
          cp === C_RIGHT_PAREN ||
          cp === C_ASTERISK ||
          cp === C_PLUS ||
          cp === C_HYPHEN ||
          cp === C_PERIOD ||
          cp === C_COLON ||
          cp === C_LESSTHAN ||
          cp === C_EQUALS ||
          cp === C_LEFT_BRACKET ||
          cp === C_BACKSLASH ||
          cp === C_RIGHT_BRACKET ||
          cp === C_HAT ||
          cp === C_UNDERSCORE ||
          cp === C_BACKTICK ||
          cp === C_LEFT_BRACE ||
          cp === C_RIGHT_BRACE ||
          cp === C_TILDE);
}

// find first special character starting from startpos, and not
// going beyond endpos, or null if none found.
const findSpecial = function(s : string, startpos : number, endpos : number) {
  let i = startpos;
  while (i <= endpos) {
    let cp = s.codePointAt(i);
    if (!cp) {
      return null;
    }
    if (isSpecial(cp)) {
      return i;
    }
    i++;
    cp = s.codePointAt(i);
  }
  return null;
}

const matchesPattern = function(match : Event, patt : RegExp) : boolean {
  return (match && patt.exec(match.annot) !== null);
}

const pattNonspace = pattern("[^ \t\r\n]");
const pattLineEnd = pattern("[ \\t]*\\r?\\n");
const pattPunctuation = pattern("['!\"#$%&\\\\'()\\*+,\\-\\.\\/:;<=>?@\\[\\]\^_`{|}~']");
const pattAutolink = pattern("\\<([^<>\\s]+)\\>");
const pattDelim = pattern("[_*~^+='\"-]");
const pattEmoji = pattern(":[\\w_+-]+:");
const pattTwoPeriods = pattern("\\.\\.");
const pattBackticks0 = pattern("`*");
const pattBackticks1 = pattern("`+");
const pattDoubleDollars = pattern("\\$\\$");
const pattSingleDollar = pattern("\\$");
const pattBackslash = pattern("\\\\");
const pattRawAttribute = pattern("\\{=[^\\s{}`]+\\}");
const pattNoteReference = pattern("%^([^]]+)%]");

const hasBrace = function(self : InlineParser, pos : number) : boolean {
  return ((pos > 0 && self.subject.codePointAt(pos - 1) === C_LEFT_BRACE) ||
          self.subject.codePointAt(pos + 1) === C_RIGHT_BRACE);
}

const alwaysTrue = function() { return true; };

const betweenMatched = function(
             c : string,
             annotation : string,
             defaultmatch : string,
             opentest : ((self : InlineParser, pos : number) => boolean)) {
  return function(self : InlineParser, pos : number, endpos : number) : number {
    let subject = self.subject;
    let can_open = find(subject, pattNonspace, pos + 1) !== null &&
                   opentest(self, pos);
    let can_close = find(subject, pattNonspace, pos - 1) !== null;
    let has_open_marker = matchesPattern(self.matches[pos - 1],
                                          pattern("open_marker"));
    let has_close_marker = pos + 1 <= endpos &&
                              subject.codePointAt(pos + 1) === C_RIGHT_BRACE;
    let endcloser = pos;
    let startopener = pos;

    // Allow explicit open/close markers to override:
    if (has_open_marker) {
      can_open = true;
      can_close = false;
      startopener = pos - 1;
    }
    if (!has_open_marker && has_close_marker) {
      can_close = true;
      can_open = false;
      endcloser = pos + 1;
    }

    if (has_open_marker && defaultmatch.match(/^right/)) {
      defaultmatch = defaultmatch.replace(/^right/, "left");
    } else if (has_close_marker && defaultmatch.match(/^left/)) {
      defaultmatch = defaultmatch.replace(/^left/, "right");
    }

    let d = c;
    if (has_close_marker) {
      d = "{" + d;
    }
    let openers = self.openers[d];

    if (can_close && openers && openers.length > 0) {
      // check openers for a match
      let opener = openers[openers.length - 1];
      if (opener.endpos !== pos - 1) { // exclude empty emph
        self.clearOpeners(opener.startpos, pos);
        self.addMatch(opener.startpos, opener.endpos, "+" + annotation);
        self.addMatch(pos, endcloser, "-" + annotation);
        return endcloser + 1;
      }
    }

    // If we get here, we didn't match an opener:
    if (can_open) {
      let e = c;
      if (has_open_marker) {
        e = "{" + e;
      }
      self.addOpener(e, { startpos: startopener, endpos: pos,
                          annot: null, substartpos: null, subendpos: null });
      self.addMatch(startopener, pos, defaultmatch);
      return pos + 1;
    } else {
      self.addMatch(pos, endcloser, defaultmatch);
      return endcloser + 1;
    }
  }
}

// handlers for specific code points:
const matchers = {
  [C_BACKTICK]: function(self : InlineParser, pos : number, endpos : number) : number | null {
    let subject = self.subject;
    let m = boundedFind(subject, pattBackticks0, pos, endpos);
    if (m === null) {
      return null;
    }
    let endchar = m.endpos;
    if (find(subject, pattDoubleDollars, pos - 2) &&
        !find(subject, pattBackslash, pos - 3)) {
      delete self.matches[pos - 2];
      delete self.matches[pos - 1];
      self.addMatch(pos - 2, endchar, "+display_math");
      self.verbatimType = "display_math"
    } else if (find(subject, pattSingleDollar, pos - 1)) {
      delete self.matches[pos - 1];
      self.addMatch(pos - 1, endchar, "+inline_math");
      self.verbatimType = "inline_math";
    } else {
      self.addMatch(pos, endchar, "+verbatim");
      self.verbatimType = "verbatim";
    }
    self.verbatim = endchar - pos + 1;
    return endchar + 1;
  },

    [C_BACKSLASH]: function(self : InlineParser, pos : number, endpos : number) : number | null {
      let subject = self.subject;
      let mLineEnd = boundedFind(subject, pattLineEnd, pos + 1, endpos);
      if (mLineEnd !== null) {
        // see if there were preceding spaces and remove them
        if (self.matches.length > 0) {
          let lastmatch = self.matches[self.matches.length - 1];
          if (lastmatch.annot === "str") {
            let ep = lastmatch.endpos;
            let sp = lastmatch.startpos;
            while (ep >= sp &&
                    (subject.codePointAt(ep) === C_SPACE ||
                     subject.codePointAt(ep) === C_TAB)) {
              ep = ep - 1;
            }
            if (ep < sp) {
              delete self.matches[self.matches.length - 1];
            } else {
              self.addMatch(sp, ep, "str");
            }
          }
        }
        self.addMatch(pos, pos, "escape");
        self.addMatch(pos + 1, mLineEnd.endpos, "hardbreak");
        return mLineEnd.endpos + 1;
      } else {
        let mPunct = boundedFind(subject, pattPunctuation, pos + 1, endpos);
        if (mPunct !== null) {
          self.addMatch(pos, pos, "escape");
          self.addMatch(mPunct.startpos, mPunct.endpos, "str");
          return mPunct.endpos + 1;
        } else if (pos + 1 <= endpos &&
                  subject.codePointAt(pos + 1) === C_SPACE) {
          self.addMatch(pos, pos, "escape");
          self.addMatch(pos + 1, pos + 1, "nbsp");
          return pos + 2;
        } else {
          self.addMatch(pos, pos, "str");
          return pos + 1;
        }
      }
    },

    [C_LESSTHAN]: function(self : InlineParser, pos : number, endpos : number) : number | null {
      let subject = self.subject;
      let m = boundedFind(subject, pattAutolink, pos, endpos);
      if (m === null) {
        return null;
      }
      let endurl = m.endpos;
      let starturl = m.startpos;
      let url = m.captures[0];
      if (url.match(/[^:]@/)) { // email
        self.addMatch(starturl, starturl, "+email");
        self.addMatch(starturl + 1, endurl - 1, "str");
        self.addMatch(endurl, endurl, "-email");
        return endurl + 1;
      } else if (url.match(/[a-zA-Z]:/)) { /// url
        self.addMatch(starturl, starturl, "+url");
        self.addMatch(starturl + 1, endurl - 1, "str");
        self.addMatch(endurl, endurl, "-url");
        return endurl + 1;
      }
      return null;
    },

    [C_TILDE]: betweenMatched('~', 'subscript', 'str', alwaysTrue),

    [C_HAT]: betweenMatched('^', 'superscript', 'str', alwaysTrue),

    [C_UNDERSCORE]: betweenMatched('_', 'emph', 'str', alwaysTrue),

    [C_ASTERISK]: betweenMatched('*', 'strong', 'str', alwaysTrue),

    [C_PLUS]: betweenMatched("+", "insert", "str", hasBrace),

    [C_EQUALS]: betweenMatched("=", "mark", "str", hasBrace),

    [C_SINGLE_QUOTE]: betweenMatched("'", "single_quoted", "right_single_quote",
                         function(self : InlineParser, pos : number) : boolean {
                            if (pos === 0) {
                              return true;
                            } else {
                              let cp = self.subject.codePointAt(pos - 1);
                              return (cp === C_SPACE ||
                                      cp === C_TAB ||
                                      cp === C_CR ||
                                      cp === C_LF ||
                                      cp === C_DOUBLE_QUOTE ||
                                      cp === C_SINGLE_QUOTE ||
                                      cp === C_HYPHEN ||
                                      cp === C_LEFT_PAREN ||
                                      cp === C_LEFT_BRACKET ||
                                      cp === C_RIGHT_BRACKET);
                            }
                          }),

    [C_DOUBLE_QUOTE]: betweenMatched('"', "double_quoted", "left_double_quote",
                                     alwaysTrue),

    [C_LEFT_BRACE]: function(self : InlineParser, pos : number, endpos : number) : number | null {
      if (boundedFind(self.subject, pattDelim, pos + 1, endpos)) {
        self.addMatch(pos, pos, "open_marker");
        return pos + 1;
      } else if (self.allowAttributes) {
        self.attributeParser = new AttributeParser(self.subject);
        self.attributeStart = pos;
        self.attributeSlices = [];
        return pos;
      } else {
        self.addMatch(pos, pos, "str");
        return pos + 1;
      }
    },

    [C_COLON]: function(self : InlineParser, pos : number, endpos : number) : number | null {
      let m = boundedFind(self.subject, pattEmoji, pos, endpos)
      if (m !== null) {
        self.addMatch(m.startpos, m.endpos, "emoji");
        return m.endpos + 1;
      } else {
        self.addMatch(pos, pos, "str");
        return pos + 1;
      }
    },

    [C_PERIOD]: function(self : InlineParser, pos : number, endpos : number) : number | null {
      if (boundedFind(self.subject, pattTwoPeriods, pos + 1, endpos)) {
        self.addMatch(pos, pos + 2, "ellipses");
        return pos + 3;
      } else {
        return null;
      }
    },

    [C_LEFT_BRACKET]: function(self : InlineParser, pos : number, endpos : number) : number {
      let m = boundedFind(self.subject, pattNoteReference, pos + 1, endpos);
      if (m !== null) { // footnote ref
        self.addMatch(pos, m.endpos, "footnote_reference");
        return m.endpos + 1;
      } else {
        self.addOpener("[", { startpos: pos, endpos: pos, annot: null,
                               substartpos: null, subendpos: null } );
        self.addMatch(pos, pos, "str");
        return pos + 1;
      }
    },

    /*

    -- 93 = ]
    [93] = function(self, pos, endpos)
      let openers = self.openers["["]
      let subject = self.subject
      if openers and #openers > 0 {
        let opener = openers[#openers]
        if opener[3] == "reference_link" {
          -- found a reference link
          -- add the matches
          let is_image = bounded_find(subject, "!", opener[1] - 1, endpos)
                  and not bounded_find(subject, "[\\]", opener[1] - 2, endpos)
          if is_image {
            self.addMatch(opener[1] - 1, opener[1] - 1, "image_marker")
            self.addMatch(opener[1], opener[2], "+imagetext")
            self.addMatch(opener[4], opener[4], "-imagetext")
          } else {
            self.addMatch(opener[1], opener[2], "+linktext")
            self.addMatch(opener[4], opener[4], "-linktext")
          }
          self.addMatch(opener[5], opener[5], "+reference")
          self.addMatch(pos, pos, "-reference")
          -- convert all matches to str
          self:str_matches(opener[5] + 1, pos - 1)
          -- remove from openers
          self:clear_openers(opener[1], pos)
          return pos + 1
        } else if bounded_find(subject, "%[", pos + 1, endpos) {
          opener[3] = "reference_link"
          opener[4] = pos  -- intermediate ]
          opener[5] = pos + 1  -- intermediate [
          self.addMatch(pos, pos + 1, "str")
          -- remove any openers between [ and ]
          self:clear_openers(opener[1] + 1, pos - 1)
          return pos + 2
        } else if bounded_find(subject, "%(", pos + 1, endpos) {
          self.openers["("] = {} -- clear ( openers
          opener[3] = "explicit_link"
          opener[4] = pos  -- intermediate ]
          opener[5] = pos + 1  -- intermediate (
          self.destination = true
          self.addMatch(pos, pos + 1, "str")
          -- remove any openers between [ and ]
          self:clear_openers(opener[1] + 1, pos - 1)
          return pos + 2
        } else if bounded_find(subject, "%{", pos + 1, endpos) {
          -- assume this is attributes, bracketed span
          self.addMatch(opener[1], opener[2], "+span")
          self.addMatch(pos, pos, "-span")
          -- remove any openers between [ and ]
          self:clear_openers(opener[1], pos)
          return pos + 1
        }
      }
    end,


    -- 40 = (
    [40] = function(self, pos)
      if not self.destination then return nil }
      self.addOpener("(", pos, pos)
      self.addMatch(pos, pos, "str")
      return pos + 1
    end,

    -- 41 = )
    [41] = function(self, pos, endpos)
      if not self.destination then return nil }
      let parens = self.openers["("]
      if parens and #parens > 0 and parens[#parens][1] {
        parens[#parens] = nil -- clear opener
        self.addMatch(pos, pos, "str")
        return pos + 1
      } else {
        let subject = self.subject
        let openers = self.openers["["]
        if openers and #openers > 0
            and openers[#openers][3] == "explicit_link" {
          let opener = openers[#openers]
          -- we have inline link
          let is_image = bounded_find(subject, "!", opener[1] - 1, endpos)
                 and not bounded_find(subject, "[\\]", opener[1] - 2, endpos)
          if is_image {
            self.addMatch(opener[1] - 1, opener[1] - 1, "image_marker")
            self.addMatch(opener[1], opener[2], "+imagetext")
            self.addMatch(opener[4], opener[4], "-imagetext")
          } else {
            self.addMatch(opener[1], opener[2], "+linktext")
            self.addMatch(opener[4], opener[4], "-linktext")
          }
          self.addMatch(opener[5], opener[5], "+destination")
          self.addMatch(pos, pos, "-destination")
          self.destination = false
          -- convert all matches to str
          self:str_matches(opener[5] + 1, pos - 1)
          -- remove from openers
          self:clear_openers(opener[1], pos)
          return pos + 1
        }
      }
    end,

    -- 45 = -
    [45]: function(self, pos, endpos)
      let subject = self.subject
      let nextpos
      if byte(subject, pos - 1) == 123 or
         byte(subject, pos + 1) == 125 then -- (123 = { 125 = })
        nextpos = betweenMatched("-", "delete", "str",
                           function(slf, p)
                             return find(slf.subject, "%{", p - 1) or
                                    find(slf.subject, "%}", p + 1)
                           end)(self, pos, endpos)
        return nextpos
      }
      -- didn't match a del, try for smart hyphens:
      let _, ep = find(subject, "%-*", pos)
      if endpos < ep {
        ep = endpos
      }
      let hyphens = 1 + ep - pos
      if byte(subject, ep + 1) == 125 then -- 125 = }
        hyphens = hyphens - 1 -- last hyphen is close del
      }
      if hyphens == 0 then  -- this means we have '-}'
        self.addMatch(pos, pos + 1, "str")
        return pos + 2
      }
      -- Try to construct a homogeneous sequence of dashes
      let all_em = hyphens % 3 == 0
      let all_en = hyphens % 2 == 0
      while hyphens > 0 do
        if all_em {
          self.addMatch(pos, pos + 2, "em_dash")
          pos = pos + 3
          hyphens = hyphens - 3
        } else if all_en {
          self.addMatch(pos, pos + 1, "en_dash")
          pos = pos + 2
          hyphens = hyphens - 2
        } else if hyphens >= 3 and (hyphens % 2 ~= 0 or hyphens > 4) {
          self.addMatch(pos, pos + 2, "em_dash")
          pos = pos + 3
          hyphens = hyphens - 3
        } else if hyphens >= 2 {
          self.addMatch(pos, pos + 1, "en_dash")
          pos = pos + 2
          hyphens = hyphens - 2
        } else {
          self.addMatch(pos, pos, "str")
          pos = pos + 1
          hyphens = hyphens - 1
        }
      }
      return pos
    },

  }
*/
}

class InlineParser {
  warn : (message : string, pos : number) => void;
  subject : string;
  matches : Event[];
  openers : OpenerMap; // map from opener type to Opener[] in reverse order
  verbatim : number; // parsing a verbatim span to be ended by N backticks
  verbatimType : string; // math or regular
  destination : boolean; // parsing link destination?
  firstpos : number; // position of first slice
  lastpos : number; // position of last slice
  allowAttributes : boolean; // allow parsing of attributes
  attributeParser : null | AttributeParser; // attribute parser
  attributeStart : null | number; // start pos of potential attribute
  attributeSlices : null | {startpos : number, endpos : number}[]; // slices we've tried to parse as atttributes
  matchers :  { [codepoint : number] : (self : InlineParser, sp : number, ep : number) => null | number }; // functions to handle different code points

  constructor(subject : string, warn : (message : string, pos : number) => void) {
    this.warn = warn;
    this.subject = subject;
    this.matches = [];
    this.openers = {};
    this.verbatim = 0;
    this.verbatimType = "";
    this.destination = false;
    this.firstpos = -1;
    this.lastpos = 0;
    this.allowAttributes = true;
    this.attributeParser = null;
    this.attributeStart = null;
    this.attributeSlices = null;
    this.matchers = matchers;
  }

  addMatch(startpos : number, endpos : number, annot : string) : void {
    this.matches[startpos] = {startpos: startpos, endpos: endpos, annot: annot};
  }

  inVerbatim() : boolean {
    return (this.verbatim > 0);
  }

  singleChar(pos : number) : number {
    this.addMatch(pos, pos, "str");
    return pos + 1;
  }

  reparseAttributes() : void {
    // Reparse attributeSlices that we tried to parse as an attribute
    let slices = this.attributeSlices;
    if (slices === null) {
      return;
    }
    this.allowAttributes = false;
    this.attributeParser = null;
    this.attributeStart = null;
    if (slices !== null) {
      slices.forEach( (slice) => {
        this.feed(slice.startpos, slice.endpos);
      });
    }
    this.allowAttributes = true;
    this.attributeSlices = null;
  }

  getMatches() : Event[] {
    let sorted = [];
    const subject = this.subject;
    let lastsp, lastep, lastannot;
    if (this.attributeParser) {
      // we're still in an attribute parse
      this.reparseAttributes();
    }
    for (let i = this.firstpos; i <= this.lastpos; i++) {
      if (i in this.matches) {
        let {startpos: sp, endpos: ep, annot: annot} = this.matches[i];
        let lastsorted = sorted[sorted.length - 1];
        if (annot == "str" && lastsorted && lastsorted.annot === "str" &&
            lastsorted.endpos === sp - 1) {
          // consolidate adjacent strs
          lastsorted.endpos = ep;
        } else {
          sorted.push(this.matches[i]);
          lastsp = sp;
          lastep = ep;
          lastannot = annot;
        }
      }
    }
    if (sorted.length > 0) {
      let last = sorted[sorted.length - 1];
      let {startpos, endpos, annot} = last;
      // remove final softbreak
      if (annot === "softbreak") {
        sorted.pop();
        last = sorted[sorted.length - 1];
        startpos = last.startpos;
        endpos = last.endpos;
        annot = last.annot;
      }
      // remove trailing spaces
      if (annot === "str" && subject.codePointAt(endpos) === 32) {
        while (endpos > startpos && subject.codePointAt(endpos) === 32) {
          endpos = endpos - 1;
        }
        sorted.push({startpos: startpos, endpos: endpos, annot: annot});
      }
      if (this.verbatim > 0) { // unclosed verbatim
        this.warn("Unclosed verbatim", endpos);
        sorted.push({ startpos: endpos,
                      endpos: endpos,
                      annot: "-" + this.verbatimType });
      }
    }
    return sorted;
  }

  addOpener(name : string, opener : Opener) : void {
    if (!this.openers[name]) {
      this.openers[name] = [];
    }
    this.openers[name].push(opener);
  }

  clearOpeners(startpos : number, endpos : number) : void {
    // Remove other openers in between the matches
    for (let k in this.openers) {
      let v = this.openers[k];
      let i = v.length - 1
      while (v[i]) {
        let opener = v[i];
        if (opener.startpos >= startpos && opener.endpos <= endpos) {
          v.splice(i, 1);
        } else if ((opener.substartpos && opener.substartpos >= startpos) &&
                   (opener.subendpos && opener.subendpos <= endpos)) {
          v[i].substartpos = null;
          v[i].subendpos = null;
          v[i].annot = null;
        } else {
          break;
        }
        i--;
      }
    }
  }

  strMatches(startpos : number, endpos : number) : void {
    // convert matches between startpos and endpos to str
    for (let i = startpos; i <= endpos; i++) {
      let m = this.matches[i];
      if (m !== null) {
        if (m.annot !== "str" && m.annot !== "escape") {
          m.annot = "str";
        }
      }
    }
  }


  feed(startpos : number, endpos : number) : void {

    // Feed a slice to the parser, updating state.
    let subject = this.subject;
    let matchers = this.matchers;
    if (this.firstpos == -1 || startpos < this.firstpos) {
      this.firstpos = startpos;
    }
    if (this.lastpos == 0 || endpos > this.lastpos) {
      this.lastpos = endpos;
    }
    let pos = startpos;
    while (pos <= endpos) {
      if (this.attributeParser !== null) {
        let sp = pos;
        let nextSpecial = findSpecial(subject, pos, endpos);
        let ep2;
        if (nextSpecial === null) {
          ep2 = endpos;
        } else {
          ep2 = nextSpecial;
        }
        let result = this.attributeParser.feed(sp, ep2);
        let ep = result.position;
        if (result.status === "done") {
          let attributeStart = this.attributeStart;
          // add attribute matches
          if (attributeStart !== null) {
            this.addMatch(attributeStart, attributeStart, "+attributes");
            this.addMatch(ep, ep, "-attributes");
          }
          let attrMatches = this.attributeParser.matches;
          // add attribute matches
          attrMatches.forEach( (match) => {
            this.addMatch(match.startpos, match.endpos, match.annot);
          });
          // restore state to prior to adding attribute parser
          this.attributeParser = null;
          this.attributeStart = null;
          this.attributeSlices = null;
          pos = ep + 1;
        } else if (result.status === "fail") {
          this.reparseAttributes();
          pos = sp;  // we'll want to go over the whole failed portion again,
                     // as no slice was added for it
        } else if (result.status === "continue") {
          if (this.attributeSlices !== null) {
            if (this.attributeSlices && this.attributeSlices.length == 0) {
              this.attributeSlices = [];
            }
            this.attributeSlices.push({startpos: sp, endpos: ep});
          }
          pos = ep + 1;
        }
      } else {
        // find next interesting character:
        let nextSpecial = findSpecial(subject, pos, endpos);
        let newpos;
        if (nextSpecial === null) {
          newpos = endpos + 1;
        } else {
          newpos = nextSpecial;
        }
        if (newpos > pos) {
          this.addMatch(pos, newpos - 1, "str");
          pos = newpos;
          if (pos > endpos) {
            break; // otherwise, fall through:
          }
        }
        // if we get here, then newpos = pos,
        // i.e. we have something interesting at pos
        let c = subject.codePointAt(pos);
        if (c === undefined) {
          throw("code point at " + pos + " is undefined.");
        }

        if (c === C_CR || c === C_LF) { // cr or lf
          if (c === C_CR && subject.codePointAt(pos + 1) === C_LF &&
               pos + 1 <= endpos) {
            this.addMatch(pos, pos + 1, "softbreak");
            pos = pos + 2;
          } else {
            this.addMatch(pos, pos, "softbreak");
            pos = pos + 1;
          }
        } else if (this.verbatim > 0) {
          if (c === 96) {
            let m = boundedFind(subject, pattBackticks1, pos, endpos);
            if (m) {
              let endchar = m.endpos;
              if (m.endpos - pos + 1 === this.verbatim) {
                // check for raw attribute
                let m2 = boundedFind(subject, pattRawAttribute, endchar + 1, endpos);
                if (m2 && this.verbatimType == "verbatim") { // raw
                  this.addMatch(pos, endchar, "-" + this.verbatimType);
                  this.addMatch(m2.startpos, m2.endpos, "raw_format");
                  pos = m2.endpos + 1;
                } else {
                  this.addMatch(pos, endchar, "-" + this.verbatimType);
                  pos = endchar + 1;
                }
                this.verbatim = 0;
                this.verbatimType = "verbatim";
              } else {
                this.addMatch(pos, endchar, "str");
                pos = endchar + 1;
              }
            } else {
              this.addMatch(pos, endpos, "str");
              pos = endpos + 1;
            }
          } else {
            this.addMatch(pos, pos, "str");
            pos = pos + 1;
          }
        } else {
          let matcher = this.matchers[c];
          if (matcher) {
            let res = matcher(this, pos, endpos);
            if (res === null) {
              pos = this.singleChar(pos);
            } else {
              pos = res;
            }
          } else {
            pos = this.singleChar(pos);
          }
        }
      }
    }


    return; // TODO
  }


}


export { InlineParser }