/**
 * This file defines (and creates) our database schema.
 *
 * NOTE: we make liberal use of the text type because in postgres there's no
 * difference between varchar and text under the hood, but varchar can be
 * excessively limiting and hard to change later on.
 */

const db = require('../helpers/db');
const config = require('../helpers/config');
const Promise = require('bluebird');

const schema_version = 3;

const run_upgrade = function(from_version, to_version) {
	var cur_version = from_version;
	var promises = [];
	const run = function(qry, params) {
		promises.push(db.query(qry, params));
	};

	if(cur_version == 1) {
		run("ALTER TABLE users ADD COLUMN last_login timestamp with time zone DEFAULT NULL");
		cur_version++;
	}

	if(cur_version == 2) {
		run("DROP INDEX spaces_users_user_id");
		cur_version++;
	}

	return Promise.all(promises);
};

var schema = [];
var indexes = [];
const builder = {
	type: {
		pk_int: 'bigserial primary key',
		pk: 'varchar(96) primary key',
		id_int: 'bigint',
		id: 'varchar(96)',
		int: 'integer',
		json: 'jsonb',
		date: 'timestamp with time zone',
		varchar: function(chars) { return 'varchar('+chars+')'; },
		text: 'text',
		bool: 'boolean',
		smallint: 'smallint',
	},
	not_null: function(type) { return type+' not null'; },

  default: function(type, df) { return type+' default '+df; },

	table: function(table_name, options) {
		var fields = options.fields;
		var table_indexes = options.indexes;

		fields.created = builder.type.date+' default CURRENT_TIMESTAMP';
		fields.updated = builder.type.date+' default CURRENT_TIMESTAMP';
		schema.push([
			'create table if not exists '+table_name+' (',
			Object.keys(fields).map(function(name) {
				var type = fields[name];
				var options = {};
				if(typeof(type) == 'object') {
					options = type;
					type = type.type;
					delete options.type;
				}
				var sql_field = [name, type];
				if(typeof(options.default) != 'undefined') {
					sql_field.push('DEFAULT '+options.default);
				}
				if(options.not_null) sql_field.push('NOT NULL');
				return sql_field.join(' ');
			}),
			')',
		].join(' '));
		if(table_indexes && table_indexes.length) {
			table_indexes.forEach(function(index) {
				var name = index.name || index.fields.join('_');
				indexes.push([
					'create index if not exists '+table_name+'_'+name+' on '+table_name+' (',
					index.fields.join(','),
					')',
				].join(' '));
			});
		}
	},
};

const ty = builder.type;

builder.table('app', {
	fields: {
		id: ty.pk,
		val: ty.text,
	},
});

builder.table('boards', {
	fields: {
		id: ty.pk,
		space_id: builder.not_null(ty.id),
		data: ty.json,
	},
	indexes: [
		{name: 'space_id', fields: ['space_id']}
	],
});

builder.table('cla', {
	fields: {
		id: ty.pk_int,
		fullname: builder.not_null(ty.text),
		email: builder.not_null(ty.text),
		sigdata: ty.json,
	},
});

builder.table('errorlog', {
	fields: {
		id: ty.pk,
		data: ty.json,
	},
});

builder.table('keychain', {
	fields: {
		id: ty.pk,
		user_id: builder.not_null(ty.id_int),
		item_id: builder.not_null(ty.id),
		data: ty.json,
	},
	indexes: [
		{name: 'user_item', fields: ['user_id', 'item_id']},
		{name: 'item', fields: ['item_id']},
	],
});

builder.table('notes', {
	fields: {
		id: ty.pk,
		space_id: builder.not_null(ty.id),
		board_id: ty.id,
		data: ty.json
	},
	indexes: [
		{name: 'space_id', fields: ['space_id', 'board_id']}
	],
});

builder.table('spaces', {
	fields: {
		id: ty.pk,
		data: ty.json,
	},
});

builder.table('spaces_invites', {
	fields: {
		id: ty.pk,
		space_id: builder.not_null(ty.id),
		from_user_id: builder.not_null(ty.id_int),
		to_user: builder.not_null(ty.text),
		data: ty.json,
	},
	indexes: [
		{name: 'space_id', fields: ['space_id']},
		{name: 'from_user_id', fields: ['from_user_id']},
		{name: 'to_user', fields: ['to_user']},
	],
});

builder.table('spaces_users', {
	fields: {
		id: ty.pk_int,
		space_id: builder.not_null(ty.id),
		user_id: builder.not_null(ty.id_int),
		role: builder.not_null(ty.varchar(24)),
	},
	indexes: [
		{name: 'user_id_space_id', fields: ['user_id', 'space_id']},
		{name: 'space_id', fields: ['space_id']},
	],
});

builder.table('sync', {
	fields: {
		id: ty.pk_int,
		item_id: builder.not_null(ty.id),
		type: builder.not_null(ty.text),
		action: builder.not_null(ty.varchar(32)),
		user_id: builder.not_null(ty.id_int),
	},
});

builder.table('sync_users', {
	fields: {
		id: ty.pk_int,
		sync_id: builder.not_null(ty.id_int),
		user_id: builder.not_null(ty.id_int),
	},
	indexes: [
		{name: 'sync_scan', fields: ['sync_id', 'user_id']},
	],
});

builder.table('users', {
	fields: {
		id: ty.pk_int,
		username: builder.not_null(ty.text),
		auth: builder.not_null(ty.text),
		active: builder.not_null(ty.bool),
		confirmed: builder.not_null(ty.bool),
		confirmation_token: ty.text,
		data: ty.json,
		last_login: ty.date,
    login_failed_last: ty.date,
    login_failed_count: builder.default(ty.int, 0),
	},
	indexes: [
		{name: 'username', fields: ['username'], unique: true},
		{name: 'last_login', fields: ['last_login']},
	],
});

function run() {
	console.log('- running DB schema');
	return Promise.each(schema, function(qry) { return db.query(qry); })
		.then(function() {
			return db.by_id('app', 'schema-version');
		})
		.then(function(schema_ver) {
			if(!schema_ver) {
				// no record? just insert it with the current version.
				return db.upsert('app', {id: 'schema-version', val: schema_version}, 'id');
			} else if(parseInt(schema_ver.val) < schema_version) {
				// run an upgrayyyyd
				var from = parseInt(schema_ver.val);
				var to = schema_version;
				console.log('- upgrading schema from v'+from+' to v'+to+'...');
				return run_upgrade(from, to)
					.then(function() {
						console.log('- schema upgraded to v'+to+'!');
						return db.upsert('app', {id: 'schema-version', val: schema_version}, 'id');
					});
			}
		})
		.then(function() {
			console.log('- creating indexes');
			return Promise.each(indexes, function(qry) { return db.query(qry); })
		})
		.then(function() { console.log('- done'); })
		.catch(function(err) {
			console.error(err, err.stack);
			process.exit(1);
		})
		.finally(function() { setTimeout(process.exit, 100); });
}

run();
