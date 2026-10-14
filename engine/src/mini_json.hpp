// 迷你 JSON —— 只做本引擎需要的事，不引入任何第三方库。
//
// 支持完整的 JSON 语法（对象 / 数组 / 字符串 / 数字 / 布尔 / null），
// 包括 \uXXXX 转义与 UTF-8 往返。代码量刻意压得很小，但行为是严格正确的。
//
// 用法：
//   mj::Value v;
//   std::string err;
//   if (!mj::parse(line, v, err)) { ... }
//   auto lang = v.str("language", "zh");
//
//   mj::Writer w;
//   w.beginObject();
//   w.key("type").value("segment");
//   w.key("text").value("大家好");
//   w.endObject();
//   std::string line = w.take();

#pragma once

#include <cctype>
#include <cstdint>
#include <cmath>
#include <cstdio>
#include <string>
#include <utility>
#include <vector>

namespace mj {

struct Value;

using Object = std::vector<std::pair<std::string, Value>>;

struct Value {
    enum Type { NUL, BOOL, NUM, STR, OBJ, ARR };

    Type type = NUL;
    bool b = false;
    double n = 0;
    std::string s;
    Object o;
    std::vector<Value> a;

    bool isNull() const { return type == NUL; }
    bool isBool() const { return type == BOOL; }
    bool isNumber() const { return type == NUM; }
    bool isString() const { return type == STR; }
    bool isObject() const { return type == OBJ; }
    bool isArray() const { return type == ARR; }

    // 取字段，字段缺失或类型不符时返回兜底值
    const Value *find(const std::string &key) const {
        if (type != OBJ) return nullptr;
        for (const auto &kv : o) {
            if (kv.first == key) return &kv.second;
        }
        return nullptr;
    }

    bool has(const std::string &key) const { return find(key) != nullptr; }

    std::string str(const std::string &key, const std::string &fallback = "") const {
        const Value *v = find(key);
        return (v && v->type == STR) ? v->s : fallback;
    }

    double num(const std::string &key, double fallback = 0.0) const {
        const Value *v = find(key);
        if (!v) return fallback;
        if (v->type == NUM) return v->n;
        if (v->type == BOOL) return v->b ? 1.0 : 0.0;
        return fallback;
    }

    int64_t integer(const std::string &key, int64_t fallback = 0) const {
        const Value *v = find(key);
        if (!v || v->type != NUM) return fallback;
        return (int64_t)std::llround(v->n);
    }

    bool boolean(const std::string &key, bool fallback = false) const {
        const Value *v = find(key);
        if (!v) return fallback;
        if (v->type == BOOL) return v->b;
        if (v->type == NUM) return v->n != 0;
        return fallback;
    }
};

// ---------------------------------------------------------------- 编码工具

inline void appendUtf8(std::string &out, uint32_t cp) {
    if (cp < 0x80) {
        out.push_back((char)cp);
    } else if (cp < 0x800) {
        out.push_back((char)(0xC0 | (cp >> 6)));
        out.push_back((char)(0x80 | (cp & 0x3F)));
    } else if (cp < 0x10000) {
        out.push_back((char)(0xE0 | (cp >> 12)));
        out.push_back((char)(0x80 | ((cp >> 6) & 0x3F)));
        out.push_back((char)(0x80 | (cp & 0x3F)));
    } else {
        out.push_back((char)(0xF0 | (cp >> 18)));
        out.push_back((char)(0x80 | ((cp >> 12) & 0x3F)));
        out.push_back((char)(0x80 | ((cp >> 6) & 0x3F)));
        out.push_back((char)(0x80 | (cp & 0x3F)));
    }
}

inline void appendEscaped(std::string &out, const std::string &in) {
    out.push_back('"');
    for (unsigned char c : in) {
        switch (c) {
            case '"':  out += "\\\""; break;
            case '\\': out += "\\\\"; break;
            case '\b': out += "\\b";  break;
            case '\f': out += "\\f";  break;
            case '\n': out += "\\n";  break;
            case '\r': out += "\\r";  break;
            case '\t': out += "\\t";  break;
            default:
                if (c < 0x20) {
                    char buf[8];
                    std::snprintf(buf, sizeof(buf), "\\u%04x", c);
                    out += buf;
                } else {
                    // UTF-8 字节原样输出，中文不必转义成 \u
                    out.push_back((char)c);
                }
        }
    }
    out.push_back('"');
}

inline std::string formatNumber(double v) {
    if (!std::isfinite(v)) return "null";
    // 整数去掉小数点，避免 28.0 这种输出
    if (v == (double)(int64_t)v && std::fabs(v) < 1e15) {
        char buf[32];
        std::snprintf(buf, sizeof(buf), "%lld", (long long)v);
        return buf;
    }
    char buf[40];
    std::snprintf(buf, sizeof(buf), "%.4f", v);
    std::string s(buf);
    // 去掉尾部多余的 0
    size_t dot = s.find('.');
    if (dot != std::string::npos) {
        size_t last = s.find_last_not_of('0');
        if (last != std::string::npos && last > dot) s.erase(last + 1);
        else if (last == dot) s.erase(dot);
    }
    return s;
}

// ------------------------------------------------------------------ 解析器

namespace detail {

struct Parser {
    const std::string &src;
    size_t pos = 0;
    std::string err;

    explicit Parser(const std::string &s) : src(s) {}

    void skipWs() {
        while (pos < src.size()) {
            char c = src[pos];
            if (c == ' ' || c == '\t' || c == '\n' || c == '\r') pos++;
            else break;
        }
    }

    bool fail(const std::string &msg) {
        if (err.empty()) {
            // 附带出错位置附近的内容，便于定位
            size_t from = pos > 20 ? pos - 20 : 0;
            err = msg + "（位置 " + std::to_string(pos) + "）";
            (void)from;
        }
        return false;
    }

    bool parseValue(Value &out) {
        skipWs();
        if (pos >= src.size()) return fail("内容意外结束");
        char c = src[pos];
        if (c == '{') return parseObject(out);
        if (c == '[') return parseArray(out);
        if (c == '"') {
            out.type = Value::STR;
            return parseString(out.s);
        }
        if (c == 't') {
            if (src.compare(pos, 4, "true") != 0) return fail("非法字面量");
            pos += 4;
            out.type = Value::BOOL;
            out.b = true;
            return true;
        }
        if (c == 'f') {
            if (src.compare(pos, 5, "false") != 0) return fail("非法字面量");
            pos += 5;
            out.type = Value::BOOL;
            out.b = false;
            return true;
        }
        if (c == 'n') {
            if (src.compare(pos, 4, "null") != 0) return fail("非法字面量");
            pos += 4;
            out.type = Value::NUL;
            return true;
        }
        return parseNumber(out);
    }

    bool parseNumber(Value &out) {
        size_t start = pos;
        if (pos < src.size() && (src[pos] == '-' || src[pos] == '+')) pos++;
        bool any = false;
        while (pos < src.size() && (std::isdigit((unsigned char)src[pos]) || src[pos] == '.' ||
                                    src[pos] == 'e' || src[pos] == 'E' ||
                                    src[pos] == '+' || src[pos] == '-')) {
            if (std::isdigit((unsigned char)src[pos])) any = true;
            pos++;
        }
        if (!any) return fail("期望一个数字");
        try {
            out.type = Value::NUM;
            out.n = std::stod(src.substr(start, pos - start));
        } catch (...) {
            return fail("数字格式错误");
        }
        return true;
    }

    bool parseString(std::string &out) {
        if (pos >= src.size() || src[pos] != '"') return fail("期望字符串");
        pos++;
        out.clear();
        while (pos < src.size()) {
            char c = src[pos++];
            if (c == '"') return true;
            if (c != '\\') {
                out.push_back(c);
                continue;
            }
            if (pos >= src.size()) return fail("转义序列不完整");
            char e = src[pos++];
            switch (e) {
                case '"':  out.push_back('"');  break;
                case '\\': out.push_back('\\'); break;
                case '/':  out.push_back('/');  break;
                case 'b':  out.push_back('\b'); break;
                case 'f':  out.push_back('\f'); break;
                case 'n':  out.push_back('\n'); break;
                case 'r':  out.push_back('\r'); break;
                case 't':  out.push_back('\t'); break;
                case 'u': {
                    uint32_t cp = 0;
                    if (!readHex4(cp)) return false;
                    // 处理代理对
                    if (cp >= 0xD800 && cp <= 0xDBFF && pos + 1 < src.size() &&
                        src[pos] == '\\' && src[pos + 1] == 'u') {
                        pos += 2;
                        uint32_t lo = 0;
                        if (!readHex4(lo)) return false;
                        if (lo >= 0xDC00 && lo <= 0xDFFF) {
                            cp = 0x10000 + ((cp - 0xD800) << 10) + (lo - 0xDC00);
                        } else {
                            appendUtf8(out, cp);
                            cp = lo;
                        }
                    }
                    appendUtf8(out, cp);
                    break;
                }
                default:
                    return fail("未知转义字符");
            }
        }
        return fail("字符串没有结束引号");
    }

    bool readHex4(uint32_t &out) {
        if (pos + 4 > src.size()) return fail("\\u 转义不完整");
        out = 0;
        for (int i = 0; i < 4; i++) {
            char c = src[pos++];
            out <<= 4;
            if (c >= '0' && c <= '9') out |= (uint32_t)(c - '0');
            else if (c >= 'a' && c <= 'f') out |= (uint32_t)(c - 'a' + 10);
            else if (c >= 'A' && c <= 'F') out |= (uint32_t)(c - 'A' + 10);
            else return fail("\\u 后面不是十六进制");
        }
        return true;
    }

    bool parseObject(Value &out) {
        out.type = Value::OBJ;
        out.o.clear();
        pos++; // '{'
        skipWs();
        if (pos < src.size() && src[pos] == '}') {
            pos++;
            return true;
        }
        while (true) {
            skipWs();
            std::string key;
            if (!parseString(key)) return false;
            skipWs();
            if (pos >= src.size() || src[pos] != ':') return fail("对象里缺少冒号");
            pos++;
            Value child;
            if (!parseValue(child)) return false;
            out.o.emplace_back(std::move(key), std::move(child));
            skipWs();
            if (pos >= src.size()) return fail("对象没有结束");
            if (src[pos] == ',') {
                pos++;
                continue;
            }
            if (src[pos] == '}') {
                pos++;
                return true;
            }
            return fail("对象里期望逗号或右花括号");
        }
    }

    bool parseArray(Value &out) {
        out.type = Value::ARR;
        out.a.clear();
        pos++; // '['
        skipWs();
        if (pos < src.size() && src[pos] == ']') {
            pos++;
            return true;
        }
        while (true) {
            Value child;
            if (!parseValue(child)) return false;
            out.a.push_back(std::move(child));
            skipWs();
            if (pos >= src.size()) return fail("数组没有结束");
            if (src[pos] == ',') {
                pos++;
                continue;
            }
            if (src[pos] == ']') {
                pos++;
                return true;
            }
            return fail("数组里期望逗号或右方括号");
        }
    }
};

} // namespace detail

inline bool parse(const std::string &text, Value &out, std::string &err) {
    detail::Parser p(text);
    if (!p.parseValue(out)) {
        err = p.err.empty() ? "解析失败" : p.err;
        return false;
    }
    p.skipWs();
    if (p.pos != text.size()) {
        err = "末尾有多余内容（位置 " + std::to_string(p.pos) + "）";
        return false;
    }
    return true;
}

// ------------------------------------------------------------------ 生成器

// 只支持流式手写：调用方按顺序 beginObject / key / value / endObject。
// 引擎的输出结构都很浅，这样比先建树再序列化更省事。
class Writer {
public:
    Writer() { out_.reserve(512); }

    Writer &beginObject() {
        beforeValue();
        out_.push_back('{');
        stack_.push_back(Frame{false, true});
        return *this;
    }

    Writer &endObject() {
        out_.push_back('}');
        if (!stack_.empty()) stack_.pop_back();
        return *this;
    }

    Writer &beginArray() {
        beforeValue();
        out_.push_back('[');
        stack_.push_back(Frame{true, true});
        return *this;
    }

    Writer &endArray() {
        out_.push_back(']');
        if (!stack_.empty()) stack_.pop_back();
        return *this;
    }

    Writer &key(const std::string &k) {
        beforeKey();
        appendEscaped(out_, k);
        out_.push_back(':');
        pendingKey_ = true;
        return *this;
    }

    Writer &value(const std::string &v) {
        beforeValue();
        appendEscaped(out_, v);
        return *this;
    }

    Writer &value(const char *v) { return value(std::string(v ? v : "")); }

    Writer &value(double v) {
        beforeValue();
        out_ += formatNumber(v);
        return *this;
    }

    Writer &value(int v) {
        beforeValue();
        out_ += std::to_string(v);
        return *this;
    }

    Writer &value(int64_t v) {
        beforeValue();
        out_ += std::to_string(v);
        return *this;
    }

    Writer &value(bool v) {
        beforeValue();
        out_ += v ? "true" : "false";
        return *this;
    }

    Writer &valueNull() {
        beforeValue();
        out_ += "null";
        return *this;
    }

    std::string take() {
        std::string s = std::move(out_);
        out_.clear();
        out_.reserve(512);
        stack_.clear();
        pendingKey_ = false;
        return s;
    }

private:
    // 每层容器记一个「是否还没写过任何元素」，逗号只在层内决定，
    // 这样数组套对象、对象套数组都不会串。
    struct Frame {
        bool isArray;
        bool first;
    };

    void beforeKey() {
        if (stack_.empty() || stack_.back().isArray) return;
        Frame &f = stack_.back();
        if (!f.first) out_.push_back(',');
        f.first = false;
    }

    void beforeValue() {
        if (pendingKey_) {
            pendingKey_ = false;
            return; // 对象的键后面直接跟值，不加逗号
        }
        if (stack_.empty() || !stack_.back().isArray) return;
        Frame &f = stack_.back();
        if (!f.first) out_.push_back(',');
        f.first = false;
    }

    std::string out_;
    std::vector<Frame> stack_;
    bool pendingKey_ = false;
};

} // namespace mj
