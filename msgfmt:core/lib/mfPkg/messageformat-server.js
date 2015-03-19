// Load each string and update the database if necessary
mfPkg.langUpdate = function(lang, strings, meta, lastSync) {
	_.each(['strings', 'compiled', 'meta'], function(key) {
		if (!mfPkg[key][lang])
			mfPkg[key][lang] = {};
	});
	mfPkg.meta[lang].extractedAt = meta.extractedAt;
	mfPkg.meta[lang].updatedAt = meta.updatedAt;

	/*
	 * See if any of our extracted strings are newer than their copy in
	 * the database and update them accordingly, then update mfPkg.string key
	 */

	var str, existing, revisionId, obj, updating, dbInsert, result, query,
		optional = ['_id', 'file', 'line', 'template', 'func', 'removed', 'fuzzy'];
	for (key in strings) {
		str = strings[key];
		existing = this.strings[lang][key];

		// skip keys which haven't been modified since last sync
		if (str.mtime <= lastSync)
			continue;

		// skip key if local copy is newer than this one (i.e. from other file)
		if (existing && existing.mtime > str.mtime)
			continue;

		// if text has changed, create a new revision, else preserve revisionId
		if (existing && existing.text == str.text && existing.removed == str.removed) {
			updating = false;
			revisionId = this.strings[lang][key].revisionId;
		} else {
			updating = true;
			revisionId = this.mfRevisions.insert({
				lang: lang,
				key: key,
				text: str.text,
				ctime: str.ctime,
			});
		}

		obj = {
			key: key,
			lang: lang,
			text: str.text,
			ctime: str.ctime,
			mtime: str.mtime,
			revisionId: revisionId
		};
		for (var i=0; i < optional.length; i++)
			if (str[optional[i]])
				obj[optional[i]] = str[optional[i]];

		// insert unfound, or re-insert on wrong _id, otherwise update
		if (existing) {
			if (str._id && existing._id == str._id) {
				dbInsert = false;
			} else {
				// non-matching ID.  remove and insert with correct ID (mfAll.js)
				this.mfStrings.remove({_id: existing._id});
				dbInsert = true;
			}
		} else {
			dbInsert = true;
		}

		/* meteor upsert does allow _id even for insert upsert
		if (this.strings[lang][key] && str._id
				&& this.strings[lang][key]._id != str._id) {
			console.log('remove');
			this.mfStrings.remove({_id: this.strings[lang][key]._id});
		}

		result = this.mfStrings.upsert({key: key, lang: lang}, { $set: obj });
		if (result.insertedId)
			obj._id = insertedId;
		if (updating)
			this.strings[lang][key] = obj;
		*/

		if (dbInsert) {
			obj._id = this.mfStrings.insert(obj)
		} else {
			this.mfStrings.update(obj._id, obj);
		}

		if (updating) {
			// does this update affect translations?
			if (existing) {
				query = { $set: {} };
				if (lang == mfPkg.native) {
					// TODO, consider string comparison with threshold to mark as fuzzy
					query['$set'].fuzzy = true;
				}
				if (str.removed)
					query['$set'].removed = true;

				this.mfStrings.update( { key: key, lang: {$ne: lang} }, query);
			}

			// finally, update the local cache
			this.strings[lang][key] = obj;			
		}

	} /* for (key in strings) */
}

// called from mfExract.js
mfPkg.addNative = function(strings, meta) {
	if (!this.initted) {

		// not initted yet, we don't know what the native lang is
		this.nativeQueue = { strings: strings, meta: meta };

	} else {

		var lastSync = this.mfMeta.findOne('syncExtracts');
		lastSync = lastSync ? lastSync.mtime : 0;

		this.langUpdate(mfPkg.native, strings, meta, lastSync);

		this['syncExtracts'] = meta.updatedAt;
		this.mfMeta.upsert('syncExtracts', {$set: {mtime: this['syncExtracts'] } });

	    this.observeFrom(meta.updatedAt, 'native');
	}
}

// called from mfTrans.js
mfPkg.syncAll = function(strings, meta) {

	var lastSync = this.mfMeta.findOne('syncTrans');
	lastSync = lastSync ? lastSync.mtime : 0;

	for (lang in strings)
		if (lang != this.native)
			this.langUpdate(lang, strings[lang], meta, lastSync);

	// TODO.  Sync native strings too, ensure _id's are the same,
	// allow for random load order	

	this['syncTrans'] = meta.updatedAt;
	this.mfMeta.upsert('syncTrans', {$set: {mtime: this['syncTrans'] } });

    this.observeFrom(meta.updatedAt, 'trans');
}

mfPkg.serverInit = function(native, options) {
    if (this.nativeQueue) {
        this.addNative(this.nativeQueue.strings, this.nativeQueue.meta);
        delete this.nativeQueue;
    }

    // If addTrans() was never called, observe full translation database
    if (!mfPkg.syncTrans)
        mfPkg.observeFrom(0, 'trans');	
}

Meteor.methods({
	// Method to send language data to client, see note in client file.
	mfLoadLangs: function(reqLang) {
		check(reqLang, String);
		//console.log(reqLang);
		var strings = {};
		for (lang in mfPkg.strings) {
			if (reqLang != lang && reqLang != 'all')
				continue;
			strings[lang] = {};
			for (key in mfPkg.strings[lang])
				strings[lang][key] = mfPkg.strings[lang][key].text.replace(/\s+/g, ' ');
		}
		return {
			strings: strings,
			lastSync: new Date().getTime()
		}
	}
});

Meteor.publish('mfStrings', function(lang, after, fullInfo) {
  var query = {}, options = {};
  check(lang, Match.OneOf(String, [String]));
  //console.log(after);
  check(after, Match.OneOf(Number, undefined, null));
  check(fullInfo, Match.Optional(Boolean));

  // fake sub
  if (lang == 'notReady')
    return null;

  // ['en', 'he'] or 'en' or 'native' or 'all'
  if (_.isArray(lang))
    query.lang = {$in: lang};
  else if (lang == 'native')
    query.lang = mfPkg.native;
  else if (lang != 'all')
    query.lang = lang;

  if (after)
    query.mtime = {$gt: after};

  if (!fullInfo)
    options.fields = { key: 1, lang: 1, text: 1 };

  return mfPkg.mfStrings.find(query, options);
});

Meteor.methods({
	'mfPkg.langList': function() {
		return _.keys(mfPkg.strings);
	},
  'msgfmt:setLocale': function(locale) {
    this.connection.locale = locale;
  }
});

// TODO, cache/optimize
Inject.obj('msgfmt:locales', function() {
  var out = {};
  for (var lang in mfPkg.meta)
    out[lang] = mfPkg.meta[lang].updatedAt;
	return out;
});

function localeCollectionToDictionary(locale) {
  var key, out = {};

  if (locale === 'all') {
    for (locale in mfPkg.strings) {
      out[locale] = {};
      for (key in mfPkg.strings[locale])
        out[locale][key] = mfPkg.strings[locale][key].text.replace(/\s+/g, ' ');    
    }
  } else {
    for (key in mfPkg.strings[locale])
      out[key] = mfPkg.strings[locale][key].text.replace(/\s+/g, ' ');    
  }
  return out;
}

// TODO, caching, compression
// return functoins when security policy doesn't allow new function
// allow fromDate?
WebApp.connectHandlers.use(function(req, res, next) {
  if (req.url.substr(0, 15) === '/msgfmt/locale/') {
    var locale = req.url.substr(15);
    res.setHeader("Content-Type", "application/json");
    res.writeHead(200);
    res.end(JSON.stringify(localeCollectionToDictionary(locale)));
    return;
  }
  next();
});
