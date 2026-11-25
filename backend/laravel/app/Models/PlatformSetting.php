<?php

namespace App\Models;

use Illuminate\Database\Eloquent\Model;

/**
 * One platform-wide setting row (Batch 10).
 *
 * The table is keyed by `key` (string PK). Values are stored as
 * plain strings; App\Support\PlatformSettings casts them to the
 * right type (int/bool/string) against the code defaults. Rows are
 * only ever written by an admin saving in Admin Panel → Platform
 * Controls — never by seeders or migrations.
 */
class PlatformSetting extends Model
{
    protected $primaryKey = 'key';

    public $incrementing = false;

    protected $keyType = 'string';

    protected $fillable = ['key', 'value'];
}
